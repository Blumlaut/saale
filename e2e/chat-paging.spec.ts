import { test, expect, type APIRequestContext, type Page } from "@playwright/test";

import { createChatSession, discardChatSessions, gotoAndSettle, sessionContext } from "./utils";
import { clearTranscript, seedTranscript } from "./fixtures";

/**
 * The transcript arrives a page at a time.
 *
 * A chat's history is read from its tail, so the server answers with the newest
 * page and the page above it on request (`?before=`). What this guards: the chat
 * opens on the newest turns, does not drag the whole history over the wire, and
 * reaches the first message when the reader asks for it.
 */

/** Matches MESSAGES_PAGE_SIZE in the messages route. */
const PAGE_SIZE = 60;
/** More than one page, so a page boundary sits in the middle of the history. */
const SEEDED = 70;

let sessionId = "";

test.beforeAll(async ({ request }: { request: APIRequestContext }) => {
  sessionId = await createChatSession(request, "e2e transcript paging");
  await seedTranscript(sessionId, SEEDED);
});

test.afterAll(async ({ request }: { request: APIRequestContext }) => {
  await clearTranscript(sessionId);
  await discardChatSessions(request, [sessionId]);
});

/** The show-earlier control, in either of the two things it can say. */
function showEarlier(page: Page) {
  return page.getByRole("button", { name: /^Show (\d+ earlier messages|earlier messages)$/ });
}

test.describe("chat transcript paging", () => {
  test("answers with the newest page and the fact that more exist", async ({ request }) => {
    const response = await request.get(`/api/chat/sessions/${sessionId}/messages`);
    expect(response.ok()).toBe(true);
    const body = (await response.json()) as {
      messages: { content: string }[];
      hasEarlier: boolean;
    };

    expect(body.messages).toHaveLength(PAGE_SIZE);
    expect(body.hasEarlier).toBe(true);
    // Transcript order, oldest of the page first, newest last.
    expect(body.messages[0]?.content).toBe(`seeded message ${SEEDED - PAGE_SIZE + 1}`);
    expect(body.messages[PAGE_SIZE - 1]?.content).toBe(`seeded message ${SEEDED}`);
  });

  test("opens on its tail and reaches the first message on request", async ({ browser }) => {
    // Revealing the held page and then reading the one above it is three
    // round trips over a real server, which the other workers are sharing.
    test.setTimeout(180_000);
    const context = await sessionContext(browser, { viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const pageRequests: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/messages?")) pageRequests.push(request.url());
    });

    try {
      await gotoAndSettle(page, `/dashboard/chat/${sessionId}`);

      // The newest turn is on screen, and the history above it is held back.
      await expect(page.getByText(`seeded message ${SEEDED}`, { exact: true })).toBeVisible();
      await expect(page.getByText("seeded message 1", { exact: true })).toHaveCount(0);
      // Opening the chat asked for one page, not for whatever is older.
      expect(pageRequests).toHaveLength(0);

      // Reveal what the page holds. Once all of it is on screen the control
      // asks the server for the page above instead.
      const readAbove = page.getByRole("button", { name: "Show earlier messages", exact: true });
      for (let step = 0; step < 3 && !(await readAbove.isVisible()); step++) {
        await showEarlier(page).first().click();
        await page.waitForTimeout(300);
      }

      await expect(readAbove).toBeVisible();
      await readAbove.click();

      await expect(page.getByText("seeded message 1", { exact: true })).toBeVisible();
      expect(pageRequests.some((url) => url.includes("before="))).toBe(true);
    } finally {
      await context.close();
    }
  });

  test("reports the page boundary it was given", async ({ request }) => {
    // The oldest row of the first page is where the second one starts.
    const first = (await (
      await request.get(`/api/chat/sessions/${sessionId}/messages`)
    ).json()) as { messages: { id: string; content: string }[] };

    const second = (await (
      await request.get(`/api/chat/sessions/${sessionId}/messages?before=${first.messages[0]!.id}`)
    ).json()) as { messages: { content: string }[]; hasEarlier: boolean };

    expect(second.messages).toHaveLength(SEEDED - PAGE_SIZE);
    expect(second.hasEarlier).toBe(false);
    expect(second.messages[0]?.content).toBe("seeded message 1");
  });

  test("refuses a cursor that is not in the chat", async ({ request }) => {
    const response = await request.get(`/api/chat/sessions/${sessionId}/messages?before=nope`);
    expect(response.status()).toBe(400);
  });
});
