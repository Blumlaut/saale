import { test, expect, type BrowserContext, type Page } from "@playwright/test";

import { createChatSession, discardChatSessions, gotoAndSettle, sessionContext } from "./utils";

/**
 * The chat's session panel.
 *
 * The panel a coder chat uses for its worktree, filled here with the chat's own
 * status (what its context holds, and what fires into it) and its workspace. The API is stubbed
 * so the panel is measured rather than the workspace: what matters here is the
 * column's width contract, the phone's sheet, and the fact that the file a
 * `show_file` call names is the one the panel opens.
 */

const FILE_PATH = "notes/report.md";
const FILE_ROOT = "/workspace";
const FILE_TEXT = "# Third quarter\n\nRevenue grew 12% on the quarter before.\n";

/** The `show_file` call the panel reads the file from. */
const SHOW_FILE = {
  id: "e2e-show-file",
  name: "show_file",
  status: "completed",
  args: { filePath: FILE_PATH },
  result: `Opened ${FILE_PATH}`,
};

const TRANSCRIPT = [
  {
    id: "e2e-m1",
    role: "user",
    content: "what does the report say about the third quarter?",
    createdAt: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "e2e-m2",
    role: "assistant",
    content: "Here is the file.",
    createdAt: "2026-01-01T00:01:00.000Z",
    toolCalls: [SHOW_FILE],
    stats: {
      model: { provider: "anthropic", name: "claude-sonnet-4.5" },
      tokens: { input: 18420, output: 1240, cacheRead: 9100, cacheWrite: 2100 },
      cost: 0.0842,
      costFromProvider: true,
      context: {
        tokens: 61200,
        window: 200000,
        parts: { systemPrompt: 4200, tools: 24800, userMessages: 14900, responses: 17300 },
      },
    },
  },
];

/** An automation bound to the chat, as the status tab lists it. */
const WATCHER = {
  id: "e2e-watch",
  name: "deploy-watch",
  enabled: true,
  cronExpression: "*/5 * * * *",
  lastTickAt: "2026-01-01T00:00:00.000Z",
  lastFiredAt: "2026-01-01T00:05:00.000Z",
  lastError: null,
  fireCount: 12,
};

const STAT = {
  root: FILE_ROOT,
  entry: {
    name: "report.md",
    path: `${FILE_ROOT}/${FILE_PATH}`,
    kind: "file",
    size: FILE_TEXT.length,
    modified: Date.parse("2026-01-01T00:00:00.000Z"),
    writable: true,
  },
};

/** Every route the panel reads, stubbed. */
async function mockChatFiles(page: Page, sessionId: string) {
  await page.route(new RegExp(`/api/chat/sessions/${sessionId}/messages`), (route) =>
    route.fulfill({
      json: {
        messages: TRANSCRIPT,
        hasEarlier: false,
        queuedMessages: [],
        session: { title: "A chat with a report" },
      },
    }),
  );
  await page.route(new RegExp(`/api/chat/sessions/${sessionId}/automations`), (route) =>
    route.fulfill({ json: { watchers: [WATCHER] } }),
  );
  await page.route(new RegExp(`/api/chat/sessions/${sessionId}/stream`), (route) =>
    route.fulfill({ status: 200, contentType: "text/event-stream", body: "" }),
  );
  await page.route(/\/api\/chat\/workspace-files/, (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("stat") === "1") return route.fulfill({ json: STAT });
    return route.fulfill({ body: FILE_TEXT, contentType: "text/markdown; charset=utf-8" });
  });
  await page.route(/\/api\/files\/raw/, (route) =>
    route.fulfill({
      body: FILE_TEXT,
      contentType: "text/markdown; charset=utf-8",
      headers: { "x-file-modified": String(STAT.entry.modified) },
    }),
  );
  await page.route(/\/api\/files\/list/, (route) =>
    route.fulfill({
      json: {
        target: { root: FILE_ROOT, capabilities: {} },
        path: FILE_ROOT,
        entries: [STAT.entry],
        truncated: false,
      },
    }),
  );
}

/** The panel with its tabs up. */
function panel(page: Page) {
  return page.locator('[data-slot="session-panel"][data-state="open"]:visible').first();
}

/** The strip of tabs it keeps while it is put away. */
function rail(page: Page) {
  return page.locator('[data-slot="session-panel-rail"]:visible').first();
}

/** Puts the panel away, so the rail is what brings it back. */
async function putAway(page: Page) {
  // The share in the transcript puts the panel up on its own; wait for it.
  await page.getByRole("button", { name: "Hide the session panel" }).click();
  await expect(rail(page)).toBeVisible();
}

function panelButton(page: Page) {
  return page
    .getByRole("button", { name: "Session panel", exact: true })
    .filter({ visible: true })
    .first();
}

test.describe("chat session panel", () => {
  let sessionId = "";
  let context: BrowserContext;
  let page: Page;

  test.beforeEach(async ({ browser, request }) => {
    sessionId = await createChatSession(request, "e2e session panel");
    context = await sessionContext(browser, { viewport: { width: 1600, height: 900 } });
    page = await context.newPage();
    await mockChatFiles(page, sessionId);
  });

  test.afterEach(async ({ request }) => {
    await context.close();
    await discardChatSessions(request, sessionId ? [sessionId] : []);
  });

  test("opens the file the chat shared beside the transcript", async () => {
    await gotoAndSettle(page, `/dashboard/chat/${sessionId}`);

    // The share in the transcript is what the panel puts itself up on.
    await expect(panel(page)).toBeVisible();

    // The path reads as the agent named it, not as the volume stores it.
    await expect(panel(page).getByText(FILE_PATH, { exact: true })).toBeVisible();
    await expect(panel(page).getByRole("button", { name: "Download report.md" })).toBeVisible();

    // The transcript keeps the room the rest of the chat view relies on.
    const transcript = page.locator('[data-slot="chat-drop-zone"]:visible').first();
    expect((await transcript.boundingBox())!.width).toBeGreaterThanOrEqual(430);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);

    // The strip's own control puts it away, and its rail stays.
    await page.getByRole("button", { name: "Hide the session panel" }).click();
    await expect(panel(page)).toHaveCount(0);
    await expect(rail(page)).toBeVisible();
    expect((await rail(page).boundingBox())!.width).toBeLessThan(60);
  });

  test("shows what the context holds and what fires into it, in one tab", async () => {
    await gotoAndSettle(page, `/dashboard/chat/${sessionId}`);
    await putAway(page);
    await rail(page).getByRole("button", { name: "Status", exact: true }).click();
    await expect(panel(page)).toBeVisible();

    // The context block is the card the transcript reports, not a new number.
    await expect(panel(page).getByText("31%")).toBeVisible();
    await expect(panel(page).getByText("61.2K / 200K")).toBeVisible();
    await expect(panel(page).getByText("claude-sonnet-4.5")).toBeVisible();
    // The automations posting into this chat sit in the same view.
    await expect(panel(page).getByText("deploy-watch")).toBeVisible();
    await expect(panel(page).getByRole("button", { name: "Automations in Jobs" })).toBeVisible();

    // Files is still one tab away, with the file the chat shared.
    await panel(page).getByRole("tab", { name: "Files" }).click();
    await expect(panel(page).getByRole("button", { name: "report.md", exact: true })).toBeVisible();
  });

  test("puts itself up when the chat shares a file", async () => {
    // The share arrives over the stream, as a live turn's does.
    await page.route(new RegExp(`/api/chat/sessions/${sessionId}/stream`), (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: [
          `event: tool_start\ndata: ${JSON.stringify({ turnId: "t1", toolCallId: "call-live", toolName: "show_file", args: { filePath: FILE_PATH } })}\n\n`,
          `event: tool_end\ndata: ${JSON.stringify({ turnId: "t1", toolCallId: "call-live", toolName: "show_file", result: `Opened ${FILE_PATH}` })}\n\n`,
        ].join(""),
      }),
    );

    await gotoAndSettle(page, `/dashboard/chat/${sessionId}`);
    await expect(panel(page)).toBeVisible();
    await expect(panel(page).getByText(FILE_PATH, { exact: true })).toBeVisible();
  });

  test("remembers the width its edge was dragged to", async () => {
    await gotoAndSettle(page, `/dashboard/chat/${sessionId}`);
    await putAway(page);
    await page.getByRole("button", { name: "Show the session panel" }).click();
    const handle = page.locator('[role="separator"][aria-label="Resize the files panel"]:visible');
    await expect(handle).toBeVisible();

    // A left-edge handle: the keyboard names the direction the edge travels.
    const before = (await handle.boundingBox())!.x;
    await handle.focus();
    await page.keyboard.press("ArrowLeft");
    await expect.poll(async () => (await handle.boundingBox())!.x).toBeLessThan(before - 8);

    await gotoAndSettle(page, `/dashboard/chat/${sessionId}`);
    await putAway(page);
    await page.getByRole("button", { name: "Show the session panel" }).click();
    await expect.poll(async () => (await handle.boundingBox())!.x).toBeLessThan(before - 8);
  });

  test("hands a phone the sheet instead of a column", async ({ browser }) => {
    const phone = await sessionContext(browser, { viewport: { width: 375, height: 667 } });
    const narrow = await phone.newPage();
    await mockChatFiles(narrow, sessionId);
    await gotoAndSettle(narrow, `/dashboard/chat/${sessionId}`);

    const transcript = narrow.locator('[data-slot="chat-drop-zone"]:visible').first();
    const fullWidth = (await transcript.boundingBox())!.width;

    await panelButton(narrow).click();
    await expect(panel(narrow)).toBeVisible();
    // The sheet lies over the chat, so the chat keeps the screen it had.
    expect((await transcript.boundingBox())!.width).toBe(fullWidth);
    expect(
      await narrow.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);

    await narrow
      .locator('[data-slot="sheet-content"]:visible')
      .getByRole("button", { name: "Close", exact: true })
      .first()
      .click();
    await expect(panel(narrow)).toBeHidden();
    await phone.close();
  });
});
