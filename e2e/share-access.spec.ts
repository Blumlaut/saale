import {
  request as playwrightRequest,
  expect,
  test,
  type APIRequestContext,
} from "@playwright/test";

import { BASE_URL, SESSION_FILE } from "./env";
import { createChatSession, discardChatSessions, gotoAndSettle } from "./utils";

/**
 * A share link is a capability, and an owner can put an account in front of it.
 * What this guards is the order of the two: a visitor without a session leaves
 * with nothing of the chat, from the page or from the JSON behind it.
 */

const TITLE = "Share access guardrail chat";

/**
 * The owner's side of the API, for a spec running signed out.
 *
 * A share can only be turned on by someone signed in, so the fixture that makes
 * one carries the session even when the browser under test does not.
 */
async function ownerRequest(): Promise<APIRequestContext> {
  return playwrightRequest.newContext({ baseURL: BASE_URL, storageState: SESSION_FILE });
}

/** A chat shared with the chosen audience, plus the token that reaches it. */
async function shareChat(
  request: APIRequestContext,
  access: "public" | "account",
): Promise<{ sessionId: string; token: string }> {
  const sessionId = await createChatSession(request, TITLE);
  const res = await request.post(`/api/chat/sessions/${sessionId}/share`, { data: { access } });
  expect(res.ok()).toBeTruthy();

  const body = (await res.json()) as { shareToken: string; access: string };
  expect(body.access).toBe(access);

  return { sessionId, token: body.shareToken };
}

test.describe("a visitor without an account", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("is turned away from a chat shared with accounts only", async ({ page }) => {
    const owner = await ownerRequest();
    const { sessionId, token } = await shareChat(owner, "account");

    try {
      // The redirect itself must not carry the chat, so read its body.
      const redirect = await page.request.get(`/share/${token}`, { maxRedirects: 0 });
      expect(redirect.status()).toBe(307);
      expect(redirect.headers()["location"]).toBe(
        `/auth/login?next=${encodeURIComponent(`/share/${token}`)}`,
      );
      expect(await redirect.text()).not.toContain(TITLE);

      // And a browser that follows it lands on the login page with nothing else.
      await page.goto(`/share/${token}`, { waitUntil: "domcontentloaded" });
      await page.waitForURL(/\/auth\/login\?/);
      expect(await page.content()).not.toContain(TITLE);
    } finally {
      await discardChatSessions(owner, [sessionId]);
      await owner.dispose();
    }
  });

  test("gets no JSON of a chat shared with accounts only", async ({ page }) => {
    const owner = await ownerRequest();
    const { sessionId, token } = await shareChat(owner, "account");

    try {
      const messages = await page.request.get(`/api/chat/sessions/share/${token}/messages`);
      expect(messages.status()).toBe(401);
      expect(await messages.text()).not.toContain(TITLE);

      const copy = await page.request.post(`/api/chat/sessions/share/${token}/copy`);
      expect(copy.status()).toBe(401);
    } finally {
      await discardChatSessions(owner, [sessionId]);
      await owner.dispose();
    }
  });

  test("still opens a chat shared with anyone", async ({ page }) => {
    const owner = await ownerRequest();
    const { sessionId, token } = await shareChat(owner, "public");

    try {
      const response = await page.goto(`/share/${token}`, { waitUntil: "domcontentloaded" });

      expect(response?.status()).toBe(200);
      await expect(page.getByRole("heading", { name: TITLE })).toBeVisible();
      await expect(page.getByRole("button", { name: "Sign in to copy" })).toBeVisible();
    } finally {
      await discardChatSessions(owner, [sessionId]);
      await owner.dispose();
    }
  });
});

test.describe("a viewer who has signed in", () => {
  test("opens a chat shared with accounts only", async ({ page, request }) => {
    const { sessionId, token } = await shareChat(request, "account");

    try {
      await page.goto(`/share/${token}`, { waitUntil: "domcontentloaded" });

      await expect(page.getByRole("heading", { name: TITLE })).toBeVisible();
      await expect(page.getByRole("button", { name: "Copy to my account" })).toBeVisible();
    } finally {
      await discardChatSessions(request, [sessionId]);
    }
  });

  test("gets the audience the owner picked in the share dialog", async ({ page, request }) => {
    const sessionId = await createChatSession(request, TITLE);

    try {
      await gotoAndSettle(page, `/dashboard/chat/${sessionId}`);

      await page.getByRole("button", { name: "Share this chat" }).click();
      await expect(page.getByRole("switch")).toBeVisible();
      await expect(page.getByRole("switch")).not.toBeChecked();
      await page.getByRole("switch").click();

      // The link is up once sharing is on, and it is the one that changes hands.
      await expect(page.getByLabel("Share link")).toHaveValue(/\/share\/[0-9a-f]{32}$/);

      // The audience is a two-way switch beside the link, not a menu.
      const audience = page.getByRole("group", { name: "Who can open the link" });
      const signedIn = audience.getByRole("button", { name: "Signed in", exact: true });
      await expect(signedIn).toBeEnabled();
      await signedIn.click();

      const shareState = async () =>
        (await (await request.get(`/api/chat/sessions/${sessionId}/share`)).json()) as {
          access: string;
          shareUrl: string;
          isShared: boolean;
        };

      await expect.poll(async () => (await shareState()).access).toBe("account");

      // The gate the dialog just set is the one an anonymous reader meets.
      const state = await shareState();
      const token = state.shareUrl.split("/").pop() as string;
      const anonymous = await playwrightRequest.newContext({
        baseURL: BASE_URL,
        storageState: { cookies: [], origins: [] },
      });
      try {
        const res = await anonymous.get(`/api/chat/sessions/share/${token}/messages`);
        expect(res.status()).toBe(401);
      } finally {
        await anonymous.dispose();
      }
    } finally {
      await discardChatSessions(request, [sessionId]);
    }
  });
});
