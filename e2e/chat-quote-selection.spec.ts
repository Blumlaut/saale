import { test, expect, type Page } from "@playwright/test";

import { bootstrapSession, type E2ESession } from "./utils";

/**
 * Selection quote guardrail.
 *
 * Marking text in the transcript must surface a small "Quote" pill next to
 * the selection — pinned to the message *window*, not to the scrollable
 * content. When the list was restructured so the jump-to-bottom button can
 * overlay the scroller, the pill kept its content-offset coordinates: in a
 * scrolled transcript it landed `scrollTop` pixels below the selection (off
 * the panel, never visible), and on unmark it flashed at the window's
 * top-left corner for one frame while fading out.
 *
 * Driven at 1280px, where the desktop shell is the one on screen; the phone
 * layout draws the same pill in the same component.
 */

const WORD = "electroencephalography";
const MESSAGE_COUNT = 16;
const BTN_LABEL = "Quote selection into your reply";

let session: E2ESession | null = null;
let sessionId = "";

/**
 * The transcript comes from the database through the app's own client — no
 * agent run is needed, and every message carries the same long word so the
 * test can mark a known target.
 */
async function seedTranscript(): Promise<void> {
  const { PrismaClient } = await import("@prisma/client");
  const { PrismaPg } = await import("@prisma/adapter-pg");

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("e2e: DATABASE_URL is not set");

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  try {
    const base = Date.now() - MESSAGE_COUNT * 60_000;
    await prisma.chatMessage.createMany({
      data: Array.from({ length: MESSAGE_COUNT }, (_, i) => ({
        sessionId,
        role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
        content: `Turn ${i + 1} — ${WORD} keeps this line long enough to mark.`,
        createdAt: new Date(base + i * 60_000),
      })),
    });
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * The message window, the pill and the live selection — measured the way the
 * eye sees them. Both shells render this markup; only one is laid out.
 */
async function geometry(page: Page) {
  return page.evaluate(
    ({ btnLabel, word }) => {
      const rect = (el: Element) => {
        const r = el.getBoundingClientRect();
        return { top: r.top, left: r.left, right: r.right, bottom: r.bottom };
      };
      const laidOut = <T extends Element>(els: T[]) =>
        els.find((el) => el.getBoundingClientRect().width > 0) ?? null;

      const btnEl = laidOut([
        ...document.querySelectorAll<HTMLElement>(`button[aria-label="${btnLabel}"]`),
      ]);
      let scroller: HTMLElement | null = null;
      for (const el of document.querySelectorAll<HTMLElement>("[data-quoteable]")) {
        if (el.getBoundingClientRect().width === 0) continue;
        for (let n: HTMLElement | null = el.parentElement; n; n = n.parentElement) {
          if (getComputedStyle(n).overflowY === "auto") {
            scroller = n;
            break;
          }
        }
        if (scroller) break;
      }
      const visibleBubble = [...document.querySelectorAll<HTMLElement>("[data-quoteable]")].find(
        (el) => {
          if (!scroller) return false;
          const r = el.getBoundingClientRect();
          const s = scroller.getBoundingClientRect();
          return (
            el.textContent?.includes(word) &&
            r.top >= s.top + 8 &&
            r.bottom <= s.bottom - 8 &&
            r.width > 40 &&
            r.height > 12
          );
        },
      );
      const sel = window.getSelection();
      const range = sel && sel.rangeCount > 0 ? sel.getRangeAt(0).getBoundingClientRect() : null;

      return {
        pill: btnEl ? rect(btnEl) : null,
        pillStyleTop: btnEl ? btnEl.style.top : null,
        pillOpacity: btnEl ? getComputedStyle(btnEl).opacity : null,
        window: scroller ? rect(scroller) : null,
        scrollTop: scroller?.scrollTop ?? null,
        scrollable: scroller ? scroller.scrollHeight > scroller.clientHeight + 40 : false,
        bubble: visibleBubble ? rect(visibleBubble) : null,
        range: range
          ? { top: range.top, left: range.left, right: range.right, bottom: range.bottom }
          : null,
        selectedText: sel ? sel.toString().trim() : "",
      };
    },
    { btnLabel: BTN_LABEL, word: WORD },
  );
}

test.describe("selection quote", () => {
  test.describe.configure({ timeout: 180_000 });

  test.beforeAll(async ({ browser, request }) => {
    session = await bootstrapSession(browser, request);

    const ctx = await browser.newContext({ storageState: session.storageState });
    const page = await ctx.newPage();
    try {
      await page.goto("/dashboard/chat", { waitUntil: "domcontentloaded" });
      const res = await page.request.post("/api/chat/sessions", {
        data: { title: "quote selection guardrail" },
      });
      expect(res.ok(), `creating a chat session failed (${res.status()})`).toBe(true);
      const body = (await res.json()) as { session?: { id?: string } };
      sessionId = body.session?.id ?? "";
      if (sessionId) await seedTranscript();
    } finally {
      await ctx.close();
    }
  });

  test.afterAll(async ({ request }) => {
    if (!sessionId) return;
    await request.delete(`/api/chat/sessions/${sessionId}`).catch((err) => {
      console.error(`e2e: cleaning up chat ${sessionId} failed`, err);
    });
  });

  test("marking text in a scrolled transcript shows the pill next to the selection", async ({
    browser,
  }) => {
    test.skip(!sessionId, "could not create a chat session");
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      storageState: session!.storageState,
    });
    const page = await ctx.newPage();

    try {
      await page.goto(`/dashboard/chat/${sessionId}`, { waitUntil: "domcontentloaded" });
      await page
        .locator('[data-slot="chat-drop-zone"]:visible [data-quoteable]')
        .first()
        .waitFor({ state: "visible", timeout: 90_000 });
      // Let the list settle at the tail (auto-scroll) before moving it.
      await page.waitForTimeout(500);

      // Read back to the middle of the transcript — the regression is invisible
      // at the tail only when `scrollTop` is zero.
      const scroll = await page.evaluate(() => {
        const el = [...document.querySelectorAll<HTMLElement>("[data-quoteable]")].find(
          (x) => x.getBoundingClientRect().width > 0,
        );
        let scroller: HTMLElement | null = null;
        for (let n: HTMLElement | null = el?.parentElement ?? null; n; n = n.parentElement) {
          if (getComputedStyle(n).overflowY === "auto") {
            scroller = n;
            break;
          }
        }
        if (!scroller) return { ok: false, scrollTop: 0, scrollHeight: 0, clientHeight: 0 };
        scroller.scrollTop = (scroller.scrollHeight - scroller.clientHeight) / 2;
        return {
          ok: scroller.scrollTop > 40,
          scrollTop: scroller.scrollTop,
          scrollHeight: scroller.scrollHeight,
          clientHeight: scroller.clientHeight,
        };
      });
      expect(
        scroll.ok,
        `the transcript is not scrollable (scrollTop ${scroll.scrollTop}, ` +
          `content ${scroll.scrollHeight}px vs viewport ${scroll.clientHeight}px)`,
      ).toBe(true);
      // Give the list's scroll handling a beat so auto-scroll is disarmed.
      await page.waitForTimeout(400);

      // Mark a word in a fully visible bubble. The list can still be
      // settling right after the scroll, so look for a target for a bit.
      let bubble: { top: number; left: number; right: number; bottom: number } | null = null;
      for (let attempt = 0; attempt < 40 && !bubble; attempt++) {
        bubble = (await geometry(page)).bubble;
        if (!bubble) await page.waitForTimeout(250);
      }
      expect(bubble, "no fully visible bubble to mark").not.toBeNull();
      const target = bubble!;
      await page.mouse.dblclick(
        target.left + (target.right - target.left) / 2,
        target.top + (target.bottom - target.top) / 2,
      );

      await expect
        .poll(
          async () => {
            const g = await geometry(page);
            return g.pill !== null && g.pillOpacity === "1";
          },
          { timeout: 15_000, message: "the quote pill never appeared while text was marked" },
        )
        .toBe(true);

      const g = await geometry(page);
      expect(g.selectedText, "the dblclick did not mark any text").not.toBe("");
      expect(g.scrollTop, "precondition: the transcript must be scrolled").toBeGreaterThan(0);
      expect(g.pill).not.toBeNull();
      expect(g.window).not.toBeNull();
      expect(g.range).not.toBeNull();

      // The pill sits inside the message window…
      expect(g.pill!.top).toBeGreaterThanOrEqual(g.window!.top - 2);
      expect(g.pill!.bottom).toBeLessThanOrEqual(g.window!.bottom + 2);
      expect(g.pill!.left).toBeGreaterThanOrEqual(g.window!.left - 2);
      expect(g.pill!.right).toBeLessThanOrEqual(g.window!.right + 2);

      // …directly above or below the marked text (6px gap, measured live).
      const above = Math.abs(g.pill!.bottom - g.range!.top) <= 10;
      const below = Math.abs(g.pill!.top - g.range!.bottom) <= 10;
      expect(
        above || below,
        `the pill (${JSON.stringify(g.pill)}) is not next to the selection (${JSON.stringify(g.range)})`,
      ).toBe(true);

      // Unmark: click off in the header. The pill must fade out *in place* —
      // the old bug snapped it to the window's top-left corner for the fade.
      const styleTopWhileVisible = g.pillStyleTop!;
      expect(styleTopWhileVisible).not.toBe("0px");
      await page.mouse.click(g.window!.left + 30, g.window!.top - 20);

      await expect
        .poll(async () => (await geometry(page)).pillStyleTop, {
          timeout: 2_000,
          message: "the pill jumped to the corner while fading out",
        })
        .toBe(styleTopWhileVisible);
      await expect
        .poll(async () => (await geometry(page)).selectedText, {
          timeout: 5_000,
          message: "the click did not clear the selection",
        })
        .toBe("");
      await expect
        .poll(async () => (await geometry(page)).pillOpacity, {
          timeout: 5_000,
          message: "the pill did not hide after the selection was cleared",
        })
        .toBe("0");
    } finally {
      await ctx.close();
    }
  });
});
