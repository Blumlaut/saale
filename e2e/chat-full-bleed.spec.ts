import { test, expect, type Browser, type Page } from "@playwright/test";

import { VIEWPORTS, bootstrapSession, type E2ESession } from "./utils";

/**
 * Chat full-bleed guardrail.
 *
 * The chat view owns the window (`.full-bleed` in globals.css) instead of
 * floating as a card inside the shell gutter. That gutter is what made a phone
 * show a "window" of dead space around an otherwise edge-to-edge app, so the
 * layout is asserted directly rather than left to review.
 */

let session: E2ESession | null = null;
let sessionId = "";

/** Create a chat session to open — the chat layout only renders with one. */
async function createSession(browser: Browser): Promise<string> {
  const ctx = await browser.newContext({ storageState: session!.storageState });
  const page = await ctx.newPage();
  try {
    await page.goto("/dashboard/chat", { waitUntil: "domcontentloaded" });
    const res = await page.request.post("/api/chat/sessions", {
      data: { title: "full bleed guardrail" },
    });
    expect(res.ok(), `creating a chat session failed (${res.status()})`).toBe(true);
    const body = (await res.json()) as { session?: { id?: string } };
    return body.session?.id ?? "";
  } finally {
    await ctx.close();
  }
}

/**
 * The chat view as the eye sees it: the widest visible panel (the conversation
 * surface), the composer's send button, and the floating navigation.
 */
async function measure(page: Page) {
  return page.evaluate(() => {
    const rect = (el: Element) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    };
    const panels = [...document.querySelectorAll(".glass-panel")]
      .filter((el) => el.getBoundingClientRect().width > 0)
      .sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width);
    const navs = [...document.querySelectorAll("nav")].filter(
      (el) => el.getBoundingClientRect().width > 0,
    );
    // Bottom bar (fixed, phones) and floating sidebar (desktop) never co-exist.
    const nav = navs.find((el) => getComputedStyle(el).position === "fixed") ?? navs[0];
    const composer = document.querySelector('button[aria-label="Send message"]');
    return {
      surface: panels[0] ? rect(panels[0]) : null,
      nav: nav ? rect(nav) : null,
      composer: composer ? rect(composer) : null,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    };
  });
}

async function openChat(browser: Browser, viewport: { width: number; height: number }) {
  const ctx = await browser.newContext({ viewport, storageState: session!.storageState });
  const page = await ctx.newPage();
  await page.goto(`/dashboard/chat/${sessionId}`, { waitUntil: "domcontentloaded" });
  // The chat surface paints immediately; the message fetch behind it can be
  // slow, so wait for the layout rather than for the network to go quiet.
  await page
    .locator(".glass-panel")
    .filter({ visible: true })
    .first()
    .waitFor({ state: "visible", timeout: 20_000 });
  await page.waitForTimeout(400);
  return { ctx, page };
}

test.describe("chat full-bleed layout", () => {
  // Bootstrapping (sign-up, admin grant, seeding) is slow; the geometry
  // assertions themselves are not.
  test.describe.configure({ timeout: 60_000 });

  test.beforeAll(async ({ browser, request }) => {
    // Creates the shared user, grants it the admin role and logs in once.
    session = await bootstrapSession(browser, request);
    sessionId = await createSession(browser);
  });

  for (const { name, width, height } of VIEWPORTS) {
    test(`chat view owns the whole window @ ${name}`, async ({ browser }) => {
      test.skip(!sessionId, "could not create a chat session");
      const { ctx, page } = await openChat(browser, { width, height });

      try {
        const { surface, nav, composer, viewportWidth, viewportHeight } = await measure(page);

        expect(surface, "no chat surface rendered").not.toBeNull();
        expect(surface!.top, "gutter above the chat view").toBeLessThanOrEqual(1);
        expect(viewportWidth - surface!.right, "gutter right of the chat view").toBeLessThanOrEqual(
          1,
        );
        expect(surface!.left, "gutter left of the chat view").toBeLessThanOrEqual(1);

        // The bottom nav is fixed over the shell, so the composer has to end
        // above it — a full-bleed view must not hand its input row to the nav.
        expect(composer, "no composer rendered").not.toBeNull();
        expect(nav, "no bottom nav rendered").not.toBeNull();
        expect(
          nav!.top - composer!.bottom,
          "the composer is hidden behind the bottom nav",
        ).toBeGreaterThanOrEqual(-1);
        expect(composer!.bottom).toBeLessThanOrEqual(viewportHeight);
      } finally {
        await ctx.close();
      }
    });
  }

  test("desktop bleeds the page but keeps the nav floating", async ({ browser }) => {
    test.skip(!sessionId, "could not create a chat session");
    const { ctx, page } = await openChat(browser, { width: 1280, height: 800 });

    try {
      const { surface, nav, viewportWidth } = await measure(page);

      expect(surface!.top, "gutter above the chat view").toBeLessThanOrEqual(1);
      expect(viewportWidth - surface!.right, "gutter right of the chat view").toBeLessThanOrEqual(
        1,
      );
      // The page bleeds to the edges; the navigation keeps its own margin.
      expect(nav, "no sidebar nav rendered").not.toBeNull();
      expect(nav!.top, "the floating nav lost its margin").toBeGreaterThan(1);
      expect(nav!.left, "the floating nav lost its margin").toBeGreaterThan(1);
    } finally {
      await ctx.close();
    }
  });
});
