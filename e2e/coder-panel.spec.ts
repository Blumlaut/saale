import { test, expect, type Browser, type Page } from "@playwright/test";

import { gotoAndSettle, sessionContext, VIEWPORTS } from "./utils";

/**
 * The coder panel's UI contract.
 *
 * The API is stubbed here: a real project needs a sandbox container with git
 * and a model provider, which the guardrail run does not have. What this suite
 * does prove is the part a unit test cannot: the three-column chat page, the
 * worktree panel over a status response, the file browser rooted at a worktree,
 * and the delete flow that has to keep the chat when git refuses.
 */

const PROJECT_ID = "e2e-project";
const CHAT_ID = "e2e-coder-chat";
const WORKTREE = "worktrees/e2e-project/c-1a2b3c4d";
const BRANCH = "wt/c-1a2b3c4d-with-a-name-long-enough-to-need-wrapping";

const NOW = "2026-01-01T09:00:00.000Z";

/**
 * The copy of an element that is on screen.
 *
 * The app shell renders the page once per shell and hides one with CSS, so
 * every locator matches twice.
 */
function shown(page: Page, selector: string) {
  return page.locator(`${selector}:visible`).first();
}

/** The on-screen copy of an element found by its text. */
function shownText(page: Page, text: string) {
  return page.locator(`text=${text}`).filter({ visible: true }).first();
}

const PROJECT = {
  id: PROJECT_ID,
  name: "e2e-project-with-a-long-name",
  slug: "e2e-project-with-a-long-name",
  repoPath: "projects/e2e-project-with-a-long-name",
  defaultBranch: "main",
  originUrl: null,
};

const CHAT = {
  id: CHAT_ID,
  title: "A coder chat with a long title that has to wrap instead of widening the row",
  lastActivityAt: NOW,
  isGenerating: false,
  worktree: { path: WORKTREE, branch: BRANCH, status: "active" },
};

const STATUS = {
  worktree: { path: WORKTREE, branch: BRANCH, baseSha: "0".repeat(40), mode: "worktree" },
  project: { id: PROJECT_ID, name: PROJECT.name, slug: PROJECT.slug },
  branch: BRANCH,
  head: "1".repeat(40),
  upstream: "",
  ahead: 2,
  behind: 0,
  changes: [
    {
      path: "src/components/a-very-long-file-name-that-cannot-wrap-inside-a-narrow-panel.tsx",
      originalPath: null,
      added: 12,
      deleted: 3,
      staged: true,
      unstaged: false,
      untracked: false,
    },
    {
      path: "notes.md",
      originalPath: null,
      added: 4,
      deleted: 0,
      staged: false,
      unstaged: true,
      untracked: false,
    },
  ],
  // The panel renders a run button per script; the field is required.
  scripts: [{ name: "test", command: "npm test", runCommand: "npm test" }],
  commits: [
    {
      sha: "abcdef1234567890",
      shortSha: "abcdef1",
      subject: "add the coder panel with a subject long enough to need two lines here",
      date: NOW,
      author: "e2e",
    },
  ],
};

const PREVIEW_URL = `https://3c21cf2806-5173-0123456789abcdef.preview.e2e.test`;

const PORTS = {
  enabled: true,
  domain: "preview.e2e.test",
  ports: [
    {
      port: 5173,
      address: "0.0.0.0",
      loopback: false,
      pid: 120,
      command: "node /app/node_modules/.bin/vite --host 0.0.0.0",
      url: PREVIEW_URL,
    },
    {
      port: 8080,
      address: "127.0.0.1",
      loopback: true,
      pid: 121,
      command: "python3 -m http.server 8080",
      url: null,
    },
  ],
};

const DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 0000000..1111111 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,3 +1,3 @@",
  " unchanged",
  "-removed line",
  "+added line",
  "",
].join("\n");

/** Every coder route the panel reads, stubbed. */
async function mockCoder(page: Page, options: { deleteStatus?: number } = {}) {
  await page.route(/\/api\/coder\/projects$/, (route) => {
    if (route.request().method() === "POST") {
      return route.fulfill({ status: 201, json: { project: PROJECT } });
    }
    return route.fulfill({
      json: {
        projects: [
          {
            id: PROJECT_ID,
            name: PROJECT.name,
            slug: PROJECT.slug,
            repoPath: PROJECT.repoPath,
            defaultBranch: "main",
            worktreeCount: 1,
            chatCount: 1,
            lastActivityAt: NOW,
          },
        ],
      },
    });
  });

  await page.route(new RegExp(`/api/coder/projects/${PROJECT_ID}$`), (route) => {
    if (route.request().method() === "DELETE") {
      const status = options.deleteStatus ?? 200;
      return route.fulfill({
        status,
        json:
          status === 200
            ? { ok: true }
            : { error: "error: the working tree is dirty, use --force to remove" },
      });
    }
    return route.fulfill({ json: { project: PROJECT, chats: [CHAT] } });
  });

  await page.route(new RegExp(`/api/coder/sessions/[^/]+/status$`), (route) =>
    route.fulfill({ json: STATUS }),
  );

  await page.route(new RegExp(`/api/coder/sessions/[^/]+/diff\\?`), (route) =>
    route.fulfill({ json: { diff: DIFF } }),
  );

  await page.route(/\/api\/chat\/sessions\/[^/]+\/messages/, (route) =>
    route.fulfill({ json: { messages: [] } }),
  );

  await page.route(/\/api\/chat\/sessions\/[^/]+\/stream/, (route) =>
    route.fulfill({ status: 200, contentType: "text/event-stream", body: "" }),
  );

  // The run stream answers with a command only once the panel has started one,
  // so mounting the terminal on an idle chat settles like the real thing.
  let terminalStarted = false;

  await page.route(new RegExp(`/api/coder/sessions/[^/]+/terminal/stream$`), (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: terminalStarted
        ? [
            `event: command\ndata: ${JSON.stringify({ type: "command", command: "npm test", startedAt: 0 })}\n\n`,
            `event: started\ndata: ${JSON.stringify({ type: "started", execId: "e2e-exec-1" })}\n\n`,
            `event: data\ndata: ${JSON.stringify({ type: "data", stream: "stdout", text: "2 passed\n" })}\n\n`,
            `event: exit\ndata: ${JSON.stringify({ type: "exit", exitCode: 0, timedOut: false, durationMs: 1500 })}\n\n`,
          ].join("")
        : "",
    }),
  );

  await page.route(new RegExp(`/api/coder/sessions/[^/]+/terminal$`), (route) => {
    terminalStarted = true;
    return route.fulfill({
      json: {
        run: {
          command: "npm test",
          startedAt: 0,
          status: "starting",
          execId: null,
          exitCode: null,
          error: null,
        },
      },
    });
  });

  await page.route(new RegExp(`/api/coder/sessions/[^/]+/terminal/input$`), (route) =>
    route.fulfill({ json: { written: 4 } }),
  );

  await page.route(new RegExp(`/api/coder/sessions/[^/]+/ports$`), (route) =>
    route.fulfill({ json: PORTS }),
  );

  await page.route(new RegExp(`/api/coder/sessions/[^/]+/ports/\\d+/kill$`), (route) =>
    route.fulfill({ json: { port: 5173, killed: true } }),
  );

  await page.route(/\/api\/files\/raw/, (route) =>
    route.fulfill({ body: "# e2e readme\n", contentType: "text/plain" }),
  );

  await page.route(/\/api\/files\/list/, (route) =>
    route.fulfill({
      json: {
        target: { root: `/workspaces/user-e2e/${WORKTREE}`, capabilities: {} },
        path: `/workspaces/user-e2e/${WORKTREE}`,
        entries: [
          {
            name: "README.md",
            path: `/workspaces/user-e2e/${WORKTREE}/README.md`,
            kind: "file",
            size: 128,
            modified: Date.parse(NOW),
            writable: true,
          },
        ],
        truncated: false,
      },
    }),
  );
}

/** A coder page with the API stubbed, on the route this test measures. */
async function openCoder(browser: Browser, path: string) {
  const context = await sessionContext(browser);
  const page = await context.newPage();
  await mockCoder(page);
  await gotoAndSettle(page, path);
  return { context, page };
}

test.describe("coder panel", () => {
  test("lists projects and opens one", async ({ browser }) => {
    const { context, page } = await openCoder(browser, "/dashboard/coder");
    const project = page.locator("text=" + PROJECT.name).first();
    await expect(project).toBeVisible();

    // A dev server can hand the page over before the row answers a click.
    await expect(async () => {
      await project.click();
      await expect(
        page.getByText("A coder chat with a long title", { exact: false }).first(),
      ).toBeVisible({ timeout: 3_000 });
    }).toPass();
    await expect(page.getByText(BRANCH, { exact: false }).first()).toBeVisible();

    await context.close();
  });

  test("shows the branch, the changed files and a diff of the one that is open", async ({
    browser,
  }) => {
    const { context, page } = await openCoder(browser, `/dashboard/coder/${PROJECT_ID}/${CHAT_ID}`);
    await expect(page.getByText(BRANCH, { exact: false }).first()).toBeVisible();
    await expect(page.getByText("notes.md", { exact: false }).first()).toBeVisible();

    await page.getByText("notes.md", { exact: false }).first().click();
    await expect(page.getByText("+added line", { exact: false })).toBeVisible();
    await expect(page.getByText("-removed line", { exact: false })).toBeVisible();

    await context.close();
  });

  test("widens the worktree panel by dragging its edge and remembers the width", async ({
    browser,
  }) => {
    const { context, page } = await openCoder(browser, `/dashboard/coder/${PROJECT_ID}/${CHAT_ID}`);
    const handle = shown(page, '[role="separator"][aria-label="Resize the worktree panel"]');
    const panel = shownText(page, "Project");

    const before = (await handle.boundingBox())!;
    await page.mouse.move(before.x + before.width / 2, before.y + 200);
    await page.mouse.down();
    // The handle is the panel's left edge: pulling it left widens the panel.
    await page.mouse.move(before.x - 200, before.y + 200, { steps: 10 });
    await page.mouse.up();

    const after = (await handle.boundingBox())!;
    expect(before.x - after.x).toBeGreaterThan(100);
    await expect(panel).toBeVisible();

    // The width is the browser's, not the server's: a reload keeps it.
    const handleX = after.x;
    await page.reload({ waitUntil: "domcontentloaded" });
    const handleAfterReload = shown(
      page,
      '[role="separator"][aria-label="Resize the worktree panel"]',
    );
    await expect(handleAfterReload).toBeVisible();
    // The width arrives with the effect that reads it, a frame after paint.
    await expect
      .poll(async () => (await handleAfterReload.boundingBox())?.x ?? 0)
      .toBeLessThan(handleX + 4);

    await context.close();
  });

  test("keeps the file rows tight in the worktree panel", async ({ browser }) => {
    const { context, page } = await openCoder(browser, `/dashboard/coder/${PROJECT_ID}/${CHAT_ID}`);
    await shown(page, '[role="tab"]:text-is("Files")').click();

    const name = page.locator('button:has-text("README.md")').first();
    await expect(name).toBeVisible();
    // The panel is a side column: a row sized like a full page reads as huge.
    const row = name.locator("xpath=..");
    const box = await row.boundingBox();
    expect(box?.height ?? 0).toBeLessThanOrEqual(30);

    await context.close();
  });

  test("opens a file as a tab in the panel", async ({ browser }) => {
    const { context, page } = await openCoder(browser, `/dashboard/coder/${PROJECT_ID}/${CHAT_ID}`);
    await shown(page, '[role="tab"]:text-is("Files")').click();
    await page.locator('button:has-text("README.md")').first().click();

    // The editor gets the width the user dragged the panel to.
    await expect(shown(page, '[role="tab"][aria-label="README.md"]')).toBeVisible();
    await expect(shown(page, '[aria-label="Download README.md"]')).toBeVisible();
    await expect(page.locator('[role="dialog"]:visible')).toHaveCount(0);

    await shown(page, '[aria-label="Close the file tab"]').click();
    await expect(page.locator('[role="tab"][aria-label="README.md"]')).toHaveCount(0);

    await context.close();
  });

  test("keeps the panel tabs on one row when a file is open", async ({ browser }) => {
    const { context, page } = await openCoder(browser, `/dashboard/coder/${PROJECT_ID}/${CHAT_ID}`);
    await shown(page, '[role="tab"]:text-is("Files")').click();
    await page.locator('button:has-text("README.md")').first().click();
    await expect(shown(page, '[role="tab"][aria-label="README.md"]')).toBeVisible();

    // A wrapped row is clipped by the strip, so the tabs it holds go unseen.
    const first = (await shown(page, '[role="tab"]:text-is("Project")').boundingBox())!;
    const last = (await shown(page, '[role="tab"]:text-is("Ports")').boundingBox())!;
    expect(Math.abs(first.y - last.y)).toBeLessThanOrEqual(1);

    await context.close();
  });

  test("runs a command in the worktree from the terminal tab", async ({ browser }) => {
    const { context, page } = await openCoder(browser, `/dashboard/coder/${PROJECT_ID}/${CHAT_ID}`);
    await shown(page, '[role="tab"]:text-is("Terminal")').click();
    await expect(page.getByText(BRANCH, { exact: false }).first()).toBeVisible();

    const input = shown(page, '[aria-label="Terminal command"]');
    await input.fill("npm test");
    await input.press("Enter");

    await expect(page.getByText(/2 passed/, { exact: false })).toBeVisible();
    await expect(page.getByText(/exit 0/, { exact: false })).toBeVisible();

    await context.close();
  });

  test("lists the ports a dev server took, each with a link that opens it", async ({ browser }) => {
    const { context, page } = await openCoder(browser, `/dashboard/coder/${PROJECT_ID}/${CHAT_ID}`);
    await shown(page, '[role="tab"]:text-is("Ports")').click();

    await expect(shownText(page, "5173")).toBeVisible();
    // A loopback bind is listed with a hint rather than a link.
    await expect(shownText(page, "8080")).toBeVisible();
    await expect(shownText(page, "loopback")).toBeVisible();
    await expect(page.locator('[aria-label="Open port 8080 in a new tab"]')).toHaveCount(0);

    const open = page.locator('[aria-label="Open port 5173 in a new tab"]');
    await expect(open).toHaveAttribute("href", PREVIEW_URL);
    await expect(open).toHaveAttribute("target", "_blank");
    await expect(open).toHaveAttribute("rel", "noreferrer");

    await context.close();
  });

  test("stops a dev server from the port row menu", async ({ browser }) => {
    const { context, page } = await openCoder(browser, `/dashboard/coder/${PROJECT_ID}/${CHAT_ID}`);
    await shown(page, '[role="tab"]:text-is("Ports")').click();
    await shown(page, '[aria-label="Port 5173 actions"]').click();

    const kill = page.waitForRequest((request) => request.url().endsWith("/ports/5173/kill"));
    await page.getByRole("menuitem", { name: "Stop server" }).click();
    await expect((await kill).method()).toBe("POST");

    await context.close();
  });

  test("keeps the chat when git refuses to remove its worktree", async ({ browser }) => {
    const context = await sessionContext(browser);
    const page = await context.newPage();
    await mockCoder(page, { deleteStatus: 409 });
    await page.route(/\/api\/chat\/sessions\/[^/]+$/, (route) =>
      route.fulfill({ status: 409, json: { error: "error: the working tree is dirty" } }),
    );

    await gotoAndSettle(page, `/dashboard/coder/${PROJECT_ID}`);
    await page
      .getByRole("button", { name: /Actions for A coder chat/ })
      .first()
      .click();
    await page.getByRole("menuitem", { name: "Delete chat" }).click();
    await page.getByRole("button", { name: "Delete", exact: true }).click();

    await expect(page.getByText(/working tree is dirty/)).toBeVisible();
    // The row is still there: nothing was half-deleted.
    await expect(
      page.getByText("A coder chat with a long title", { exact: false }).first(),
    ).toBeVisible();

    await context.close();
  });

  test("fits the project list and the chat page at phone widths", async ({ browser }) => {
    for (const viewport of VIEWPORTS) {
      const context = await sessionContext(browser, {
        viewport: { width: viewport.width, height: viewport.height },
      });
      const page = await context.newPage();
      await mockCoder(page);

      for (const route of ["/dashboard/coder", `/dashboard/coder/${PROJECT_ID}`]) {
        await gotoAndSettle(page, route);
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(overflow, `${route} at ${viewport.name}`).toBeLessThanOrEqual(1);
      }

      // Four tabs and a preview URL have to fit the same panel, which is a
      // sheet at this width.
      await gotoAndSettle(page, `/dashboard/coder/${PROJECT_ID}/${CHAT_ID}`);
      await shown(page, '[aria-label="Open worktree panel"]').click();
      await shown(page, '[role="tab"]:text-is("Ports")').click();
      await expect(shownText(page, "5173")).toBeVisible();
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `ports at ${viewport.name}`).toBeLessThanOrEqual(1);

      await context.close();
    }
  });
});
