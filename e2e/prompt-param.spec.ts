import { test, expect, request as playwrightRequest, type Page } from "@playwright/test";

import { BASE_URL, SESSION_FILE } from "./env";
import {
  createChatSession,
  discardChatSessions,
  E2E_PASSWORD,
  E2E_USERNAME,
  gotoAndSettle,
} from "./utils";

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

/** Answer the first message of `sessionId`, recording what the page sent. */
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

/** Answer the session the page creates for the prompt with one that exists. */
async function mockSessionCreate(page: Page, sessionId: string): Promise<void> {
  await page.route(/\/api\/chat\/sessions(\?|$)/, (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    return route.fulfill({ json: { session: { id: sessionId } } });
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
    await mockSessionCreate(page, sessionId);

    await gotoAndSettle(page, `/dashboard/chat?q=${encodeURIComponent(PROMPT)}`);

    await expect(page).toHaveURL(new RegExp(`/dashboard/chat/${sessionId}$`));
    expect(sent).toEqual([PROMPT]);
  });

  test("opens the chat list when the prompt is empty", async ({ page }) => {
    const sent: string[] = [];
    await mockFirstMessage(page, sessionId, sent);

    await gotoAndSettle(page, "/dashboard/chat?q=");

    await expect(page.getByRole("button", { name: "New Chat", exact: true })).toBeVisible();
    expect(sent).toEqual([]);
  });
});

test.describe("a signed-out visitor", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("comes back to the prompt after signing in", async ({ page }) => {
    // The browser has no session; the fixture it needs still has to make one.
    const api = await playwrightRequest.newContext({
      baseURL: BASE_URL,
      storageState: SESSION_FILE,
    });
    const sent: string[] = [];
    try {
      const sessionId = await createChatSession(api, "e2e prompt param signed out");
      try {
        await mockFirstMessage(page, sessionId, sent);
        await mockSessionCreate(page, sessionId);

        // The login page has no shell, so it is settled by its form instead.
        await page.goto(`/dashboard/chat?q=${encodeURIComponent(PROMPT)}`);
        await page.locator('input[name="username"]').waitFor();

        const signIn = new URL(page.url());
        expect(signIn.pathname).toBe("/auth/login");
        const next = signIn.searchParams.get("next") ?? "";
        expect(next.startsWith("/dashboard/chat?q=")).toBe(true);
        expect(new URL(next, "http://saale.invalid").searchParams.get("q")).toBe(PROMPT);

        await page.fill('input[name="username"]', E2E_USERNAME);
        await page.fill('input[name="password"]', E2E_PASSWORD);
        await page.click('button[type="submit"]');

        await expect(page).toHaveURL(new RegExp(`/dashboard/chat/${sessionId}$`));
        expect(sent).toEqual([PROMPT]);
      } finally {
        await discardChatSessions(api, [sessionId]);
      }
    } finally {
      await api.dispose();
    }
  });
});
