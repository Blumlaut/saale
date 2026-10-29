import { test, expect, type APIRequestContext, type Browser, type Page } from "@playwright/test";

import { createChatSession, discardChatSessions, gotoAndSettle, sessionContext } from "./utils";

/**
 * The transcript's two promises, in a real browser where reflow and scroll
 * anchoring are the browser's own:
 *
 * - on the tail, growth is followed. an unfolded thinking block, a panel
 *   dragged wider. The top of the transcript leaves the viewport and the tail
 *   stays where it was.
 * - reading back, growth leaves the reader's place alone.
 *
 * Mocked messages: what is under test is the transcript's layout, not a model.
 */

const TURNS = 8;

/** Long enough that the transcript overflows any laptop height. */
function transcript() {
  const rows = [];
  for (let i = 0; i < TURNS; i++) {
    rows.push({
      id: `u${i}`,
      role: "user",
      content: `Question ${i}. ${"lorem ipsum dolor sit amet consectetur adipiscing elit. ".repeat(4)}`,
      thinking: undefined,
      toolCalls: undefined,
      parentMessageId: undefined,
      createdAt: new Date(Date.UTC(2026, 0, 1, 12, i * 2)).toISOString(),
      attachments: undefined,
    });
    rows.push({
      id: `a${i}`,
      role: "assistant",
      content: `Answer ${i}. ${"Ut enim ad minim veniam quis nostrud exercitation ullamco laboris. ".repeat(6)}`,
      thinking: Array.from(
        { length: 40 },
        (_, line) =>
          `Reasoning line ${line}. ${"the answer needs a plan before it needs words. ".repeat(2)}`,
      ).join("\n"),
      toolCalls: undefined,
      parentMessageId: undefined,
      createdAt: new Date(Date.UTC(2026, 0, 1, 12, i * 2 + 1)).toISOString(),
      attachments: undefined,
    });
  }
  return rows;
}

let sessionId = "";

test.beforeAll(async ({ request }: { request: APIRequestContext }) => {
  sessionId = await createChatSession(request, "auto-scroll");
});

test.afterAll(async ({ request }: { request: APIRequestContext }) => {
  await discardChatSessions(request, [sessionId]);
});

async function openChat(browser: Browser): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await sessionContext(browser, { viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await page.route(/\/api\/chat\/sessions\/[^/]+\/messages$/, (route) =>
    route.fulfill({
      json: { messages: transcript(), queuedMessages: [], session: { title: "auto-scroll" } },
    }),
  );
  await gotoAndSettle(page, `/dashboard/chat/${sessionId}`);
  await page.locator("[data-quoteable]").first().waitFor({ state: "visible", timeout: 20_000 });
  return { page, close: () => context.close() };
}

/** How far the transcript sits from its tail. */
function distanceFromTail(page: Page): Promise<number> {
  return page.evaluate(() => {
    const el = document.querySelector<HTMLElement>("[data-transcript]");
    if (!el) throw new Error("the transcript is not on the page");
    return Math.round(el.scrollHeight - el.clientHeight - el.scrollTop);
  });
}

function transcriptHeight(page: Page): Promise<number> {
  return page.evaluate(() => {
    const el = document.querySelector<HTMLElement>("[data-transcript]");
    if (!el) throw new Error("the transcript is not on the page");
    return el.scrollHeight;
  });
}

/** Hand the browser two frames: one to lay the change out, one to land on it. */
function frameSettled(page: Page): Promise<void> {
  return page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

/**
 * The tail is where it belongs once the frame that grew the transcript has been
 * laid out. Not "eventually": a view that sits below the fold until something
 * else re-renders is the bug this file is about.
 */
async function expectTail(page: Page): Promise<void> {
  await frameSettled(page);
  expect(await distanceFromTail(page)).toBeLessThanOrEqual(1);
}

/** Drag the chat list's edge by `deltaX`, `steps` pointer moves. */
async function dragChatList(
  page: Page,
  deltaX: number,
  { steps = 12, onStep }: { steps?: number; onStep?: () => Promise<void> } = {},
): Promise<void> {
  const handle = page.getByRole("separator", { name: "Resize chat list" });
  const box = await handle.boundingBox();
  if (!box) throw new Error("the chat list has no resize handle");
  const x = box.x + box.width / 2;
  const y = box.y + 200;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let step = 1; step <= steps; step++) {
    await page.mouse.move(x + (deltaX * step) / steps, y);
    if (onStep) await onStep();
  }
  await page.mouse.up();
}

/** A reasoning block's toggle, in either appearance (condensed rows or cards). */
const thinkingRows = (page: Page) => page.getByRole("button", { name: /Thinking|Thought process/ });

const jumpButton = (page: Page) => page.getByRole("button", { name: "Jump to the latest message" });

test.describe("chat auto-scroll", () => {
  test("follows the reflow on every step of a chat list drag", async ({ browser }) => {
    const { page, close } = await openChat(browser);
    try {
      await expectTail(page);

      // Narrower and wider than it started. The view is pinned on each step,
      // not just once the drag ends.
      await dragChatList(page, 120, { onStep: () => expectTail(page) });
      await expectTail(page);
      await dragChatList(page, -180, { onStep: () => expectTail(page) });
      await expectTail(page);

      // The tail is what stays on screen, not the top of the transcript.
      await expect(page.locator("[data-quoteable]").last()).toBeInViewport();
    } finally {
      await close();
    }
  });

  test("unfolds a thinking block without dropping off the tail", async ({ browser }) => {
    const { page, close } = await openChat(browser);
    try {
      await expectTail(page);
      const before = await transcriptHeight(page);

      const lastThinking = thinkingRows(page).last();
      await lastThinking.click();
      await expect(lastThinking).toHaveAttribute("aria-expanded", "true");
      await expect.poll(() => transcriptHeight(page)).toBeGreaterThan(before);
      await expectTail(page);
      await expect(page.locator("[data-quoteable]").last()).toBeInViewport();

      // Folding it back is the same promise in reverse.
      await lastThinking.click();
      await expect(lastThinking).toHaveAttribute("aria-expanded", "false");
      await expectTail(page);
    } finally {
      await close();
    }
  });

  test("leaves a reader reading earlier turns alone, and follows once they return", async ({
    browser,
  }) => {
    const { page, close } = await openChat(browser);
    try {
      await expectTail(page);

      await page.locator("[data-transcript]").hover();
      await page.mouse.wheel(0, -2400);
      await expect(jumpButton(page)).toBeVisible();
      expect(await distanceFromTail(page)).toBeGreaterThan(1000);

      // A drag, then an unfolded block: neither may pull them back down.
      await dragChatList(page, 100);
      await expect(jumpButton(page)).toBeVisible();
      await thinkingRows(page).first().click();
      await expect(jumpButton(page)).toBeVisible();
      expect(await distanceFromTail(page)).toBeGreaterThan(1000);

      // Back on the tail, the very next growth is followed. Without waiting:
      // the wheel above is still fresh, and a jump answers it.
      await jumpButton(page).click();
      await expectTail(page);
      await expect(jumpButton(page)).toBeHidden();

      const before = await transcriptHeight(page);
      await thinkingRows(page).last().click();
      await expect.poll(() => transcriptHeight(page)).toBeGreaterThan(before);
      await expectTail(page);
    } finally {
      await close();
    }
  });
});
