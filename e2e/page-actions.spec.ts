import { test, expect, type Page } from "@playwright/test";

import { gotoAndSettle, sessionContext } from "./utils";
import { mockCouncilWorkspace } from "./council-mocks";

/**
 * One action row, one action size.
 *
 * Every page puts its actions in the first row of its first panel, and every
 * action is the same `h-8` button. The suite measured that by hand once, after
 * tasks, jobs, infrastructure, contacts, models, users, roles and the admin
 * settings page had each grown their own row and their own size. These checks
 * read the rendered page instead:
 *
 *   1. The page's first labelled button sits inside the first panel. A button
 *      floating above the cards is the "outside the card" regression.
 *   2. It is 32px tall (34 with its border). A page-sized button is the
 *      `size="sm"`/`xs`/`md:h-9` regression.
 *   3. Everything else in that row is the same height, so a row cannot mix an
 *      icon button with a taller labelled one.
 *
 * A new page with an action belongs in PAGES.
 */

/** The reference action button: 32px plus a 1px border top and bottom. */
const ACTION_HEIGHT = 34;

/** Routes with a page action, and the pages that must stay action-free. */
const PAGES: { path: string; prepare?: (page: Page) => Promise<void> }[] = [
  { path: "/dashboard/tasks" },
  { path: "/dashboard/infra" },
  { path: "/dashboard/contacts" },
  { path: "/dashboard/jobs/agents" },
  { path: "/dashboard/jobs/scheduled" },
  { path: "/dashboard/jobs/watchers" },
  { path: "/dashboard/coder" },
  { path: "/dashboard/council", prepare: mockCouncilWorkspace },
  { path: "/admin/models/providers" },
  { path: "/admin/models/availability" },
  { path: "/admin/users" },
  { path: "/admin/roles" },
  { path: "/admin/plugins" },
  { path: "/admin/plugins/logs" },
  { path: "/admin/settings" },
];

interface ActionRow {
  /** What the first labelled button says, so a failure names it. */
  label: string;
  /** False when no panel wraps it. */
  inFirstPanel: boolean;
  height: number;
  /** Heights of the labelled buttons sharing its row. */
  rowHeights: number[];
}

async function measureActionRow(page: Page): Promise<ActionRow | null> {
  return page.evaluate(() => {
    const main = document.querySelector("main");
    if (!main) return null;

    const buttons = [...main.querySelectorAll<HTMLElement>('[data-slot="button"]')]
      .map((element) => ({ element, rect: element.getBoundingClientRect() }))
      .filter(({ rect }) => rect.width > 0 && rect.height > 0)
      // DOM order is not visual order; the action row is the topmost one.
      .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);

    // Icon-only buttons carry no words, so they are not the page action.
    const first = buttons.find(({ rect }) => rect.width > 40);
    if (!first) return null;

    const row = first.element.parentElement;
    const panel = first.element.closest(".liquid-glass");
    const firstPanel = main.querySelector(".liquid-glass");

    return {
      label: (first.element.textContent ?? "").trim() || "an unnamed button",
      inFirstPanel: Boolean(panel) && panel === firstPanel,
      height: Math.round(first.rect.height),
      rowHeights: row
        ? [...row.querySelectorAll<HTMLElement>('[data-slot="button"]')]
            .map((element) => element.getBoundingClientRect())
            // Icon-only buttons are a different size on purpose.
            .filter((rect) => rect.width > 40 && rect.height > 0)
            .map((rect) => Math.round(rect.height))
        : [],
    };
  });
}

async function assertPageActions(page: Page, path: string): Promise<void> {
  const row = await measureActionRow(page);
  test.skip(!row, `${path} has no labelled action`);

  expect(row!.inFirstPanel, `${path}: ${row!.label} is outside the first panel`).toBe(true);
  expect(row!.height, `${path}: ${row!.label} is ${row!.height}px tall`).toBe(ACTION_HEIGHT);
  expect(
    row!.rowHeights.every((height) => height === ACTION_HEIGHT),
    `${path}: the action row mixes heights ${row!.rowHeights.join(", ")}`,
  ).toBe(true);
}

test.describe("page action rows", () => {
  for (const { path, prepare } of PAGES) {
    test(path, async ({ browser }) => {
      const ctx = await sessionContext(browser, { viewport: { width: 1280, height: 900 } });
      const page = await ctx.newPage();

      try {
        await prepare?.(page);
        const response = await gotoAndSettle(page, path, { quietNetwork: true });

        expect(response?.status(), `${path}: responded ${response?.status()}`).toBeLessThan(400);
        await expect(page.getByText("Something went wrong")).toHaveCount(0);

        await assertPageActions(page, path);
      } finally {
        await ctx.close();
      }
    });
  }
});
