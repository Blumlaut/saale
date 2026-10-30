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

const FOLDED_CHAT = {
  id: "e2e-folded-chat",
  title: "The chat the landing page lists under its project",
  lastActivityAt: NOW,
  pinned: false,
  isGenerating: false,
  origin: "user",
  worktree: { path: WORKTREE, branch: BRANCH, status: "active" },
};

const CHAT = {
  id: CHAT_ID,
  title: "A coder chat with a long title that has to wrap instead of widening the row",
  lastActivityAt: NOW,
  isGenerating: false,
  worktree: { path: WORKTREE, branch: BRANCH, status: "active" },
};

/** The project's chat list reads the chat endpoint, so a row has its own shape. */
const CHAT_SESSION = {
  id: CHAT_ID,
  title: CHAT.title,
  temporary: false,
  pinned: false,
  messageCount: 0,
  watcherCount: 0,
  isGenerating: false,
  origin: "user",
  worktree: { branch: BRANCH },
  createdAt: NOW,
  updatedAt: NOW,
  lastActivityAt: NOW,
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
      conflicted: false,
    },
    {
      path: "notes.md",
      originalPath: null,
      added: 4,
      deleted: 0,
      staged: false,
      unstaged: true,
      untracked: false,
      conflicted: false,
    },
  ],
  // The panel renders a run button per script; the field is required.
  scripts: [{ name: "test", command: "npm test", runCommand: "npm test" }],
  remotes: [{ name: "origin", url: "git@github.com:acme/e2e-project.git" }],
  stashes: 0,
  commitsTruncated: false,
  commits: [
    {
      sha: "abcdef1234567890",
      shortSha: "abcdef1",
      subject: "add the coder panel with a subject long enough to need two lines here",
      date: NOW,
      author: "e2e",
      refs: [],
      pushed: false,
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

/** What one test wants the panel to read differently from the shared fixtures. */
interface CoderMockOptions {
  /** Fields to replace on the worktree status, e.g. an empty change list. */
  status?: Partial<typeof STATUS>;
}

/** Every coder route the panel reads, stubbed. */
async function mockCoder(page: Page, options: CoderMockOptions = {}) {
  // The folded chat is a stub, so its conversation has to answer too.
  await page.route(new RegExp(`/api/chat/sessions/${FOLDED_CHAT.id}/messages$`), (route) =>
    route.fulfill({ json: { messages: [], session: { title: FOLDED_CHAT.title } } }),
  );

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
            chatCount: 2,
            lastActivityAt: NOW,
            chats: [FOLDED_CHAT],
          },
        ],
      },
    });
  });

  await page.route(/\/api\/chat\/sessions(\?projectId=[^&]*)?$/, (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill({
      json: {
        project: {
          id: PROJECT_ID,
          name: PROJECT.name,
          slug: PROJECT.slug,
          defaultBranch: PROJECT.defaultBranch,
        },
        sessions: [CHAT_SESSION],
      },
    });
  });

  await page.route(/\/api\/chat\/sessions\/bulk$/, (route) => {
    const { ids } = JSON.parse(route.request().postData() ?? "{}") as { ids: string[] };
    return route.fulfill({ json: { deleted: ids, failed: [] } });
  });

  await page.route(new RegExp(`/api/coder/sessions/[^/]+/status(\\?|$)`), (route) =>
    route.fulfill({ json: { ...STATUS, ...options.status } }),
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
async function openCoder(browser: Browser, path: string, options: CoderMockOptions = {}) {
  const context = await sessionContext(browser);
  const page = await context.newPage();
  await mockCoder(page, options);
  await gotoAndSettle(page, path);
  return { context, page };
}

test.describe("coder panel", () => {
  test("lists projects and opens one", async ({ browser }) => {
    const { context, page } = await openCoder(browser, "/dashboard/coder");
    const project = page.locator('[data-slot="project-row"]').first();
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

  test("opens a project's chat from the landing page in one click", async ({ browser }) => {
    const { context, page } = await openCoder(browser, "/dashboard/coder");
    const row = shown(page, '[data-slot="session-row"]');
    await expect(row).toContainText(FOLDED_CHAT.title);
    // The branch is what tells two chats of one project apart.
    await expect(row).toContainText(BRANCH);
    // The project has more chats than the fold shows, so the rest is one link.
    await expect(page.getByRole("link", { name: "All 2 chats" })).toHaveAttribute(
      "href",
      `/dashboard/coder/${PROJECT_ID}`,
    );

    await row.click();

    await expect(page).toHaveURL(new RegExp(`/dashboard/coder/${PROJECT_ID}/${FOLDED_CHAT.id}$`));
    // The chat itself, not just its URL: its worktree panel is beside it.
    await expect(
      shown(page, '[role="separator"][aria-label="Resize the worktree panel"]'),
    ).toBeVisible();

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

  test("pages a long change list and reads a diff only for the file that is open", async ({
    browser,
  }) => {
    const diffs: string[] = [];
    const changes = Array.from({ length: 130 }, (_, index) => ({
      path: `generated/file-${index}.ts`,
      originalPath: null,
      added: 1,
      deleted: 0,
      staged: false,
      unstaged: true,
      untracked: false,
      conflicted: false,
    }));
    const { context, page } = await openCoder(
      browser,
      `/dashboard/coder/${PROJECT_ID}/${CHAT_ID}`,
      {
        status: { changes },
      },
    );
    // Registered after the panel has loaded, so a diff request is a real one.
    await page.route(new RegExp(`/api/coder/sessions/[^/]+/diff\\?`), (route) => {
      diffs.push(route.request().url());
      return route.fulfill({ json: { diff: DIFF } });
    });

    // A worktree missing its .gitignore lists thousands of paths; the panel
    // mounts a page of them and offers the rest.
    await expect(shown(page, 'button:has-text("Show 30 more")')).toBeVisible();
    await expect(page.locator('button:has-text("file-120.ts")')).toHaveCount(0);
    expect(diffs).toHaveLength(0);

    await shown(page, 'button:has-text("Show 30 more")').click();
    await expect(shown(page, 'button:has-text("file-129.ts")')).toBeVisible();

    await shown(page, 'button:has-text("file-120.ts")').click();
    await expect(shownText(page, "+added line")).toBeVisible();
    expect(diffs).toHaveLength(1);

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

  test("commits what is staged, saying so first", async ({ browser }) => {
    const sent: unknown[] = [];
    const { context, page } = await openCoder(browser, `/dashboard/coder/${PROJECT_ID}/${CHAT_ID}`);
    await page.route(new RegExp(`/api/coder/sessions/[^/]+/git$`), async (route) => {
      sent.push(route.request().postDataJSON());
      await route.fulfill({ json: { ok: true, output: "" } });
    });

    await shown(page, 'button:has-text("Commit…")').click();
    await shown(page, 'textarea[aria-label="Commit message"]').fill("add the panel's git actions");
    await page.locator('[role="dialog"]:visible button:has-text("Commit")').last().click();

    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]).toEqual({
      action: "commit",
      message: "add the panel's git actions",
      amend: false,
      push: false,
    });

    await context.close();
  });

  test("marks a commit only this checkout has and pushes the branch", async ({ browser }) => {
    const sent: unknown[] = [];
    const { context, page } = await openCoder(browser, `/dashboard/coder/${PROJECT_ID}/${CHAT_ID}`);
    await page.route(new RegExp(`/api/coder/sessions/[^/]+/git$`), async (route) => {
      sent.push(route.request().postDataJSON());
      await route.fulfill({ json: { ok: true, output: "" } });
    });

    // The branch is two ahead, and the commit above the upstream says why.
    await expect(shown(page, '[aria-label="Not pushed"]')).toBeVisible();

    await shown(page, '[aria-label="Push"]').click();

    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]).toEqual({ action: "push" });

    await context.close();
  });

  test("switches branch from the branch menu", async ({ browser }) => {
    const sent: unknown[] = [];
    const { context, page } = await openCoder(browser, `/dashboard/coder/${PROJECT_ID}/${CHAT_ID}`);
    await page.route(new RegExp(`/api/coder/sessions/[^/]+/branches$`), (route) =>
      route.fulfill({
        json: {
          branches: [
            { name: BRANCH, upstream: "", current: true },
            { name: "main", upstream: "origin/main", current: false },
          ],
        },
      }),
    );
    await page.route(new RegExp(`/api/coder/sessions/[^/]+/git$`), async (route) => {
      sent.push(route.request().postDataJSON());
      await route.fulfill({ json: { ok: true, output: "" } });
    });

    await shown(page, '[aria-label="Branches"]').click();
    await shown(page, '[role="menuitem"]:has-text("main")').click();

    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]).toEqual({ action: "branch", name: "main" });

    await context.close();
  });

  test("stashes the worktree from the panel menu", async ({ browser }) => {
    const sent: unknown[] = [];
    const { context, page } = await openCoder(browser, `/dashboard/coder/${PROJECT_ID}/${CHAT_ID}`);
    await page.route(new RegExp(`/api/coder/sessions/[^/]+/git$`), async (route) => {
      sent.push(route.request().postDataJSON());
      await route.fulfill({ json: { ok: true, output: "" } });
    });

    await shown(page, '[aria-label="More git actions"]').click();
    await shown(page, '[role="menuitem"]:has-text("Stash changes")').click();

    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]).toEqual({ action: "stash" });

    await context.close();
  });

  test("keeps the commit dialog away from a clean tree", async ({ browser }) => {
    const { context, page } = await openCoder(
      browser,
      `/dashboard/coder/${PROJECT_ID}/${CHAT_ID}`,
      {
        status: { changes: [] },
      },
    );

    await expect(shownText(page, "Worktree clean. All changes are committed.")).toBeVisible();
    await expect(page.locator('button:has-text("Commit…")')).toHaveCount(0);

    await context.close();
  });

  test("discards a file only after asking", async ({ browser }) => {
    const sent: unknown[] = [];
    const { context, page } = await openCoder(browser, `/dashboard/coder/${PROJECT_ID}/${CHAT_ID}`);
    await page.route(new RegExp(`/api/coder/sessions/[^/]+/git$`), async (route) => {
      sent.push(route.request().postDataJSON());
      await route.fulfill({ json: { ok: true, output: "" } });
    });

    await shown(page, '[aria-label="Actions for notes.md"]').click();
    await shown(page, '[role="menuitem"]:has-text("Discard changes")').click();

    await expect(page.locator('[role="alertdialog"]:visible')).toContainText("notes.md");
    await expect(page.locator('[role="alertdialog"]:visible')).toContainText("cannot be undone");
    expect(sent).toHaveLength(0);

    await page.locator('[role="alertdialog"]:visible button:has-text("Discard")').click();

    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]).toEqual({ action: "discard", paths: ["notes.md"] });

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

  test("edits a file and saves it", async ({ browser }) => {
    const writes: { path: string; content: string }[] = [];
    const { context, page } = await openCoder(browser, `/dashboard/coder/${PROJECT_ID}/${CHAT_ID}`);
    await page.route(/\/api\/files\/write/, async (route) => {
      const body = route.request().postDataJSON() as { path: string; content: string };
      writes.push(body);
      await route.fulfill({
        json: { path: body.path, size: body.content.length, modified: Date.now() },
      });
    });

    await shown(page, '[role="tab"]:text-is("Files")').click();
    await page.locator('button:has-text("README.md")').first().click();

    // Monaco boots its worker after the file arrives, so the editor is late.
    const editor = shown(page, ".monaco-editor");
    await expect(editor).toBeVisible({ timeout: 30_000 });
    await editor.locator(".view-lines").click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type("edited in the panel");

    await expect(shown(page, '[title="Unsaved changes"]')).toBeVisible();
    await shown(page, 'button:has-text("Save")').click();

    await expect.poll(() => writes.length).toBe(1);
    expect(writes[0]?.path).toBe(`/workspaces/user-e2e/${WORKTREE}/README.md`);
    expect(writes[0]?.content).toContain("edited in the panel");
    await expect(shown(page, 'button:has-text("Save")')).toBeDisabled();

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
    await expect(shown(page, '[aria-label="Terminal output"] .xterm')).toBeVisible();

    const sent = page.waitForRequest(
      (request) => request.url().endsWith("/terminal") && request.method() === "POST",
    );
    const input = shown(page, '[aria-label="Terminal command"]');
    await input.fill("npm test");
    await input.press("Enter");

    expect((await sent).postDataJSON()).toMatchObject({ command: "npm test" });

    // The terminal draws the run into the DOM, so the output is readable here.
    await expect(page.getByText(/2 passed/)).toBeVisible();
    await expect(page.getByText(/exit 0/)).toBeVisible();

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
    await mockCoder(page);
    // git refuses to remove a worktree that still holds uncommitted work.
    await page.route(/\/api\/chat\/sessions\/bulk$/, (route) =>
      route.fulfill({
        json: {
          deleted: [],
          failed: [{ sessionId: CHAT_ID, error: "error: the working tree is dirty" }],
        },
      }),
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
