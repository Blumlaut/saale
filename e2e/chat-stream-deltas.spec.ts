import { test, expect, type APIRequestContext, type Browser, type Page } from "@playwright/test";

import { createChatSession, discardChatSessions, gotoAndSettle, sessionContext } from "./utils";

/**
 * The stream carries a growing text block as chunks (`token_delta` /
 * `thinking_delta`) with a full snapshot every second, instead of re-sending
 * the whole block per token. This is the browser end of it: a real EventSource
 * feeds a real transcript, and the reasoning block has to end up whole.
 *
 * Mocked stream: what is under test is how the client assembles what arrives,
 * not a model.
 */

const THINKING = "Weighing the question. The answer needs a plan before it needs words. ";
const ANSWER = "Hello world, from a streamed answer.";

let sessionId = "";

test.beforeAll(async ({ request }: { request: APIRequestContext }) => {
  sessionId = await createChatSession(request, "stream deltas");
});

test.afterAll(async ({ request }: { request: APIRequestContext }) => {
  await discardChatSessions(request, [sessionId]);
});

/** One SSE frame, in the wire format the server writes. */
function sse(id: number, event: string, data: unknown): string {
  return `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * The turn as the tracker publishes it: an opening snapshot, then chunks.
 * No `done`, so the transcript keeps the live bubble and the assertions are
 * about what the stream built rather than about a reload.
 */
function streamBody(turnId: string): string {
  return [
    sse(1, "turn_start", { turnId, startedAt: new Date().toISOString() }),
    sse(2, "thinking", { turnId, thinking: THINKING.slice(0, 20) }),
    sse(3, "thinking_delta", { turnId, delta: THINKING.slice(20), offset: 20 }),
    sse(4, "token_delta", { turnId, delta: ANSWER.slice(0, 12), offset: 0 }),
    sse(5, "token_delta", { turnId, delta: ANSWER.slice(12), offset: 12 }),
    sse(6, "turn_end", { turnId, text: ANSWER, thinking: THINKING }),
  ].join("");
}

async function openStreamingChat(
  browser: Browser,
): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await sessionContext(browser, { viewport: { width: 390, height: 844 } });
  const page = await context.newPage();

  await page.route(/\/api\/chat\/sessions\/[^/]+\/messages$/, (route) =>
    route.fulfill({
      json: { messages: [], queuedMessages: [], session: { title: "stream deltas" } },
    }),
  );

  // The first connection carries the run. The reconnects the ended body causes
  // get nothing, so the live bubble is never rebuilt from a replay.
  let served = false;
  await page.route(/\/api\/chat\/sessions\/[^/]+\/stream/, (route) => {
    if (served) {
      void route.fulfill({ status: 200, contentType: "text/event-stream", body: "" });
      return;
    }
    served = true;
    void route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      headers: { "Cache-Control": "no-cache", "X-Accel-Buffering": "no" },
      body: streamBody("turn-deltas"),
    });
  });

  await gotoAndSettle(page, `/dashboard/chat/${sessionId}`);
  return { page, close: () => context.close() };
}

test.describe("streamed text chunks", () => {
  test("assembles the reasoning block and the answer from chunks", async ({ browser }) => {
    const { page, close } = await openStreamingChat(browser);
    try {
      // The reasoning block ships folded, so its text is only in the DOM once
      // it is opened.
      const thinkingRow = page.getByRole("button", { name: /Thinking|Thought process/ }).first();
      await expect(thinkingRow).toBeVisible();
      await thinkingRow.click();

      // The whole reasoning, assembled from the opening snapshot and the chunk
      // that followed it. Folded, the same text is also the row's preview.
      await expect(page.locator("pre").filter({ hasText: THINKING.trim() })).toBeVisible();

      await expect(page.getByText(ANSWER, { exact: false })).toBeVisible();
    } finally {
      await close();
    }
  });

  test("renders markdown across the blocks of a live answer", async ({ browser }) => {
    // The live bubble renders block by block (the finished ones are parsed
    // once), so a heading, a loose list and a fenced block all have to come out
    // of a run that never sends the whole answer at once.
    const answer = [
      "## Plan",
      "",
      "First, the steps:",
      "",
      "1. one",
      "",
      "2. two",
      "",
      "Then the code:",
      "",
      "```ts",
      "const a = 1;",
      "",
      "const b = 2;",
      "```",
      "",
      "And a closing **bold** line.",
      "",
    ].join("\n");

    const context = await sessionContext(browser, { viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    try {
      await page.route(/\/api\/chat\/sessions\/[^/]+\/messages$/, (route) =>
        route.fulfill({
          json: { messages: [], queuedMessages: [], session: { title: "stream deltas" } },
        }),
      );
      const frames = [
        sse(1, "turn_start", { turnId: "t-md", startedAt: new Date().toISOString() }),
      ];
      let offset = 0;
      for (let id = 2; offset < answer.length; id++) {
        const delta = answer.slice(offset, offset + 7);
        frames.push(sse(id, "token_delta", { turnId: "t-md", delta, offset }));
        offset += delta.length;
      }
      await page.route(/\/api\/chat\/sessions\/[^/]+\/stream/, (route) =>
        route.fulfill({
          status: 200,
          contentType: "text/event-stream",
          body: frames.join(""),
        }),
      );

      await gotoAndSettle(page, `/dashboard/chat/${sessionId}`);

      await expect(page.getByRole("heading", { name: "Plan" })).toBeVisible();
      // A loose list is one list: both items belong to it, and neither arrives
      // twice.
      await expect(page.getByRole("listitem").filter({ hasText: "one" })).toHaveCount(1);
      await expect(page.getByRole("listitem").filter({ hasText: "two" })).toHaveCount(1);
      await expect(page.locator("pre").filter({ hasText: "const b = 2;" })).toBeVisible();
      await expect(page.locator("strong").filter({ hasText: "bold" })).toBeVisible();
      await expect(page.getByText("Plan", { exact: true })).toHaveCount(1);
    } finally {
      await context.close();
    }
  });

  test("does not splice a chunk the transcript cannot continue from", async ({ browser }) => {
    // A page load mid-run replays whatever the buffer still holds. A chunk
    // whose offset is ahead of the empty bubble would garble the text if it
    // were appended anyway.
    const context = await sessionContext(browser, { viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    try {
      await page.route(/\/api\/chat\/sessions\/[^/]+\/messages$/, (route) =>
        route.fulfill({
          json: { messages: [], queuedMessages: [], session: { title: "stream deltas" } },
        }),
      );
      await page.route(/\/api\/chat\/sessions\/[^/]+\/stream/, (route) =>
        route.fulfill({
          status: 200,
          contentType: "text/event-stream",
          body: [
            sse(1, "turn_start", { turnId: "turn-gap", startedAt: new Date().toISOString() }),
            sse(2, "token_delta", { turnId: "turn-gap", delta: "second half", offset: 11 }),
            sse(3, "token", { turnId: "turn-gap", text: "the whole answer" }),
          ].join(""),
        }),
      );

      await gotoAndSettle(page, `/dashboard/chat/${sessionId}`);
      await expect(page.getByText("the whole answer", { exact: false })).toBeVisible();
      await expect(page.getByText("second half", { exact: false })).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
});
