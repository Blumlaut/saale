import { test, expect, type Browser, type Page } from "@playwright/test";

import { bootstrapSession, type E2ESession } from "./utils";

/**
 * Chat multi-select guardrail.
 *
 * Chats are picked by tapping them  hold on touch, ctrl/⌘-click with a pointer
 *  and while picking, a row is a single target: a tap on the selection box, on
 * the row's padding, or right beside the text all pick the same chat. Rows are
 * ~50px tall and thumbs are not precise, so the hit area is measured and tapped
 * rather than assumed, and the gestures are driven with real touch events.
 *
 * Driven at 768px: the narrowest console layout, where the row is at its
 * tightest. Phones draw the same rows inside the session sheet, whose layout is
 * covered by the modal guardrails.
 */

const ALPHA = "selection alpha";
const BETA = "selection beta";
const DELTA = "selection delta";
const EPSILON = "selection epsilon";

let session: E2ESession | null = null;

/** Fixtures arrive through the real API; each test removes what it created. */
async function createChats(browser: Browser, titles: string[]): Promise<string[]> {
  const ctx = await browser.newContext({ storageState: session!.storageState });
  const page = await ctx.newPage();
  try {
    await page.goto("/dashboard/chat", { waitUntil: "domcontentloaded" });
    const ids: string[] = [];
    for (const title of titles) {
      const res = await page.request.post("/api/chat/sessions", { data: { title } });
      expect(res.ok(), `creating "${title}" failed (${res.status()})`).toBe(true);
      const body = (await res.json()) as { session?: { id?: string } };
      if (!body.session?.id) throw new Error(`no session id for "${title}" (${res.status()})`);
      ids.push(body.session.id);
    }
    return ids;
  } finally {
    await ctx.close();
  }
}

/** The chat list with its rows on screen. `/dashboard/chat` is the empty view. */
async function openList(browser: Browser) {
  const ctx = await browser.newContext({
    viewport: { width: 768, height: 900 },
    hasTouch: true,
    storageState: session!.storageState,
  });
  const page = await ctx.newPage();
  await page.goto("/dashboard/chat", { waitUntil: "domcontentloaded" });
  await page
    .locator('[data-slot="session-row"]:visible')
    .first()
    .waitFor({ state: "visible", timeout: 30_000 });
  return { ctx, page };
}

/** The row as the eye sees it: fill, padding and all. */
function row(page: Page, title: string) {
  return page.locator('[data-slot="session-row"]:visible').filter({ hasText: title }).first();
}

/** The one control inside the row  what a tap has to reach. */
function rowToggle(page: Page, title: string) {
  return row(page, title).locator("button").first();
}

/** Press and hold a point with a real touch, the way a thumb does. */
async function holdTouch(page: Page, x: number, y: number, ms: number) {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    await page.waitForTimeout(ms);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } finally {
    await cdp.detach().catch(() => {});
  }
}

async function discard(page: Page, ids: string[]) {
  for (const id of ids) {
    await page.request.delete(`/api/chat/sessions/${id}`).catch((err) => {
      console.error(`e2e: cleaning up chat ${id} failed`, err);
    });
  }
}

test.describe("chat multi-select", () => {
  test.describe.configure({ timeout: 120_000 });

  test.beforeAll(async ({ browser, request }) => {
    session = await bootstrapSession(browser, request);
  });

  test("a tap picks a chat anywhere on its row", async ({ browser }) => {
    const chats = await createChats(browser, [ALPHA, BETA]);
    const { ctx, page } = await openList(browser);

    try {
      // Start the selection from the row menu: deterministic, and it covers the
      // labelled path for anyone who does not know the gestures.
      await row(page, ALPHA).locator("button").last().click();
      await page.getByRole("menuitem", { name: "Select chat" }).click();
      await expect(rowToggle(page, ALPHA)).toHaveAttribute("aria-pressed", "true");

      // The row's control has to reach every edge of the row, or a tap that
      // lands a few pixels off does nothing at all.
      const geometry = await row(page, BETA).evaluate((el) => {
        const inner = el.querySelector("button")!.getBoundingClientRect();
        const outer = el.getBoundingClientRect();
        return {
          outer: { left: outer.left, top: outer.top, right: outer.right, bottom: outer.bottom },
          inner: { left: inner.left, top: inner.top, right: inner.right, bottom: inner.bottom },
        };
      });
      for (const edge of ["left", "top", "right", "bottom"] as const) {
        const untappable =
          edge === "left" || edge === "top"
            ? geometry.inner[edge] - geometry.outer[edge]
            : geometry.outer[edge] - geometry.inner[edge];
        expect(
          untappable,
          `the row leaves its ${edge} edge untappable  a tap there selects nothing`,
        ).toBeLessThanOrEqual(1);
      }

      const box = await row(page, BETA).boundingBox();
      const indicator = await row(page, BETA)
        .locator('[data-slot="selection-indicator"]')
        .boundingBox();
      expect(box, "the row has no box").not.toBeNull();
      expect(indicator, "the row shows no selection box").not.toBeNull();

      const midX = box!.x + box!.width / 2;
      const midY = box!.y + box!.height / 2;

      // Six taps on one chat: one toggle each, never a double toggle (which
      // would leave the count where it started).
      const probes: Array<[string, number, number]> = [
        ["the left edge", box!.x + 2, midY],
        ["the right edge", box!.x + box!.width - 2, midY],
        ["the top edge", midX, box!.y + 2],
        ["the bottom edge", midX, box!.y + box!.height - 2],
        [
          "the selection box",
          indicator!.x + indicator!.width / 2,
          indicator!.y + indicator!.height / 2,
        ],
        ["the gap beside the box", indicator!.x + indicator!.width + 2, midY],
      ];

      let selected = false;
      for (const [what, x, y] of probes) {
        await page.mouse.click(x, y);
        selected = !selected;
        await expect(
          rowToggle(page, BETA),
          `a tap on ${what} did not toggle the chat`,
        ).toHaveAttribute("aria-pressed", selected ? "true" : "false");
      }
      await expect(page.getByText("1 selected")).toBeVisible();
    } finally {
      await discard(page, chats);
      await ctx.close();
    }
  });

  test("one hold picks exactly one chat, even at the list's edge", async ({ browser }) => {
    const chats = await createChats(browser, [ALPHA, BETA]);
    const { ctx, page } = await openList(browser);

    try {
      // The bottom-most row on screen: when the selection bar appears it takes
      // room from the list, so a hold here is where the click that follows the
      // gesture would land on whichever row slid under the finger.
      const boxes = await page
        .locator('[data-slot="session-row"]:visible')
        .evaluateAll((els) =>
          els
            .map((el) => el.getBoundingClientRect())
            .filter((box) => box.height > 0 && box.bottom < window.innerHeight),
        );
      const edge = boxes[boxes.length - 1];
      if (!edge) throw new Error("no row was on screen to hold");

      await holdTouch(page, edge.x + edge.width / 2, edge.y + edge.height / 2, 700);

      await expect(page.getByText("1 selected")).toBeVisible();
      await expect(
        page.locator('[data-slot="session-row"] button[aria-pressed="true"]'),
        "a hold at the list's edge picked a chat nobody touched",
      ).toHaveCount(1);
    } finally {
      await discard(page, chats);
      await ctx.close();
    }
  });

  test("holding a chat picks it without opening it, and picks delete together", async ({
    browser,
  }) => {
    const chats = await createChats(browser, [DELTA, EPSILON]);
    const { ctx, page } = await openList(browser);

    try {
      const deltaBox = await row(page, DELTA).boundingBox();
      expect(deltaBox, "the held row has no box").not.toBeNull();
      await holdTouch(
        page,
        deltaBox!.x + deltaBox!.width / 2,
        deltaBox!.y + deltaBox!.height / 2,
        700,
      );

      await expect(
        rowToggle(page, DELTA),
        "holding a chat did not start a selection",
      ).toHaveAttribute("aria-pressed", "true");
      await expect(page, "the hold opened the chat it was selecting").toHaveURL(
        /\/dashboard\/chat$/,
      );

      // A second tap adds to the selection instead of opening that chat.
      const epsilonBox = await row(page, EPSILON).boundingBox();
      expect(epsilonBox, "the tapped row has no box").not.toBeNull();
      await page.touchscreen.tap(
        epsilonBox!.x + epsilonBox!.width / 2,
        epsilonBox!.y + epsilonBox!.height / 2,
      );
      await expect(rowToggle(page, EPSILON)).toHaveAttribute("aria-pressed", "true");
      await expect(page.getByText("2 selected")).toBeVisible();

      await page.getByRole("button", { name: "Delete 2 selected chats" }).click();
      await page.getByRole("button", { name: "Delete" }).click();

      // Both picks are gone from the list and the view stayed on the list.
      await expect(row(page, DELTA)).toHaveCount(0);
      await expect(row(page, EPSILON)).toHaveCount(0);
      await expect(page, "the view left the chat list").toHaveURL(/\/dashboard\/chat$/);
      await expect(page.getByText(/selected/)).toHaveCount(0);
    } finally {
      await discard(page, chats);
      await ctx.close();
    }
  });
});
