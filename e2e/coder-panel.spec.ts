import { test, expect, type Page } from "@playwright/test";

import { bootstrapSession, gotoAndSettle, VIEWPORTS, type E2ESession } from "./utils";

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
  worktree: { path: WORKTREE, branch: BRANCH, baseSha: "0".repeat(40) },
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

  await page.route(new RegExp(`/api/coder/sessions/[^/]+/terminal$`), (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: [
        `event: started\ndata: ${JSON.stringify({ type: "started", execId: "e2e-exec-1" })}\n\n`,
        `event: data\ndata: ${JSON.stringify({ type: "data", stream: "stdout", text: "2 passed\n" })}\n\n`,
        `event: exit\ndata: ${JSON.stringify({ type: "exit", exitCode: 0, timedOut: false, durationMs: 1500 })}\n\n`,
      ].join(""),
    }),
  );

  await page.route(new RegExp(`/api/coder/sessions/[^/]+/terminal/input$`), (route) =>
    route.fulfill({ json: { written: 4 } }),
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

let session: E2ESession | null = null;

test.describe("coder panel", () => {
  test.describe.configure({ timeout: 90_000 });

  test.beforeAll(async ({ browser, request }) => {
    session = await bootstrapSession(browser, request);
  });

  test("lists projects and opens one", async ({ browser }) => {
    test.skip(!session, "login failed");
    const context = await browser.newContext({ storageState: session!.storageState });
    const page = await context.newPage();
    await mockCoder(page);

    await gotoAndSettle(page, "/dashboard/coder");
    await expect(page.locator("text=" + PROJECT.name).first()).toBeVisible();

    await page
      .locator("text=" + PROJECT.name)
      .first()
      .click();
    await expect(
      page.getByText("A coder chat with a long title", { exact: false }).first(),
    ).toBeVisible();
    await expect(page.getByText(BRANCH, { exact: false }).first()).toBeVisible();

    await context.close();
  });

  test("shows the branch, the changed files and a diff of the one that is open", async ({
    browser,
  }) => {
    test.skip(!session, "login failed");
    const context = await browser.newContext({ storageState: session!.storageState });
    const page = await context.newPage();
    await mockCoder(page);

    await gotoAndSettle(page, `/dashboard/coder/${PROJECT_ID}/${CHAT_ID}`);
    await expect(page.getByText(BRANCH, { exact: false }).first()).toBeVisible();
    await expect(page.getByText("notes.md", { exact: false }).first()).toBeVisible();

    await page.getByText("notes.md", { exact: false }).first().click();
    await expect(page.getByText("+added line", { exact: false })).toBeVisible();
    await expect(page.getByText("-removed line", { exact: false })).toBeVisible();

    await context.close();
  });

  test("keeps the file rows tight in the worktree panel", async ({ browser }) => {
    test.skip(!session, "login failed");
    const context = await browser.newContext({ storageState: session!.storageState });
    const page = await context.newPage();
    await mockCoder(page);

    await gotoAndSettle(page, `/dashboard/coder/${PROJECT_ID}/${CHAT_ID}`);
    await shown(page, '[role="tab"]:text-is("Files")').click();

    const name = page.locator('button:has-text("README.md")').first();
    await expect(name).toBeVisible();
    // The panel is a side column: a row sized like a full page reads as huge.
    const row = name.locator("xpath=..");
    const box = await row.boundingBox();
    expect(box?.height ?? 0).toBeLessThanOrEqual(30);

    await context.close();
  });

  test("runs a command in the worktree from the terminal tab", async ({ browser }) => {
    test.skip(!session, "login failed");
    const context = await browser.newContext({ storageState: session!.storageState });
    const page = await context.newPage();
    await mockCoder(page);

    await gotoAndSettle(page, `/dashboard/coder/${PROJECT_ID}/${CHAT_ID}`);
    await shown(page, '[role="tab"]:text-is("Terminal")').click();
    await expect(page.getByText(BRANCH, { exact: false }).first()).toBeVisible();

    const input = shown(page, '[aria-label="Terminal command"]');
    await input.fill("npm test");
    await input.press("Enter");

    await expect(page.getByText(/2 passed/, { exact: false })).toBeVisible();
    await expect(page.getByText(/exit 0/, { exact: false })).toBeVisible();

    await context.close();
  });

  test("keeps the chat when git refuses to remove its worktree", async ({ browser }) => {
    test.skip(!session, "login failed");
    const context = await browser.newContext({ storageState: session!.storageState });
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
    test.skip(!session, "login failed");

    for (const viewport of VIEWPORTS) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        storageState: session!.storageState,
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

      await context.close();
    }
  });
});
