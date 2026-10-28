import { test, expect, type Page } from "@playwright/test";

import { createChatSession, discardChatSessions, gotoAndSettle } from "./utils";

/**
 * A browser opening the chat with a prompt in the URL: Firefox's AI chatbot
 * sidebar hands the selected text of a page to its provider as `?q=`. The chat
 * starts on its own, the prompt arrives as its first message, and the URL moves
 * onto the session so a reload starts nothing new.
 *
 * The message POST is answered here: an agent run is not part of this claim.
 */

const PROMPT =
  "I’m on page “Composer” with “<selection>a & b</selection>” selected.\n\nPlease explain the key concepts.";

/** Answer the first message of `sessionId` instead of prompting the agent. */
async function mockFirstMessage(page: Page, sessionId: string, sent: string[]): Promise<void> {
  await page.route(new RegExp(`/api/chat/sessions/${sessionId}/messages(\\?|$)`), (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const body = route.request().postDataJSON() as { content?: string };
    sent.push(body.content ?? "");
    return route.fulfill({
      json: {
        message: {
          id: "e2e-prompt-param-message",
          sessionId,
          role: "user",
          content: body.content ?? "",
          createdAt: new Date().toISOString(),
        },
        queued: false,
      },
    });
  });
}

test.describe("a chat started from a URL prompt", () => {
  let sessionId = "";

  test.beforeEach(async ({ request }) => {
    sessionId = await createChatSession(request, "e2e prompt param");
  });

  test.afterEach(async ({ request }) => {
    await discardChatSessions(request, [sessionId]);
  });

  test("starts the chat and sends the prompt once", async ({ page }) => {
    const sent: string[] = [];
    await mockFirstMessage(page, sessionId, sent);
    await page.route(/\/api\/chat\/sessions(\?|$)/, (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      return route.fulfill({ json: { session: { id: sessionId } } });
    });

    await gotoAndSettle(page, `/dashboard/chat?q=${encodeURIComponent(PROMPT)}`);

    await expect(page).toHaveURL(new RegExp(`/dashboard/chat/${sessionId}$`));
    expect(sent).toEqual([PROMPT]);
  });

  test("opens the chat list when the prompt is empty", async ({ page }) => {
    const sent: string[] = [];
    await mockFirstMessage(page, sessionId, sent);

    await gotoAndSettle(page, "/dashboard/chat?q=");

    await expect(page).toHaveURL(/\/dashboard\/chat$/);
    await expect(page.getByRole("button", { name: "New Chat" })).toBeVisible();
    expect(sent).toEqual([]);
  });
});
