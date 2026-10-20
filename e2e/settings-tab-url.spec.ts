import { test, expect, type Page } from "@playwright/test";

import { bootstrapSession, type E2ESession } from "./utils";

/**
 * Settings tab persistence.
 *
 * The active tab lives in the query string (`?tab=...`) so a refresh or a
 * shared link lands on the tab the user was on instead of snapping back to
 * the first one. Tab switches use `router.replace`, so no per-tab history
 * entries are expected — only the URL itself is asserted.
 */

const DESKTOP = { width: 1280, height: 900 };

let session: E2ESession | null = null;

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser, request }) => {
  session = await bootstrapSession(browser, request);
});

/** Open the settings page fresh (a hard navigation, so the URL is authoritative). */
async function openSettings(
  browser: import("@playwright/test").Browser,
  path: string,
): Promise<Page> {
  test.skip(!session, "login failed");
  const ctx = await browser.newContext({
    viewport: DESKTOP,
    storageState: session!.storageState,
  });
  const page = await ctx.newPage();
  await page.goto(path, { waitUntil: "domcontentloaded" });
  return page;
}

test.describe("settings tab url", () => {
  test("keeps the active tab in the URL across a refresh", async ({ browser }) => {
    const page = await openSettings(browser, "/dashboard/settings");

    // No query string means the first tab.
    await expect(page.getByRole("heading", { name: "AI & Models" })).toBeVisible();

    await page.getByRole("tab", { name: "Memories" }).click();
    await expect(page).toHaveURL(/tab=memories$/);
    await expect(page.getByRole("button", { name: "Add Memory" })).toBeVisible();

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(/tab=memories$/);
    await expect(page.getByRole("button", { name: "Add Memory" })).toBeVisible();
  });

  test("falls back to the first tab for an unknown value", async ({ browser }) => {
    const page = await openSettings(browser, "/dashboard/settings?tab=bogus");

    await expect(page.getByRole("heading", { name: "AI & Models" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "AI & Models" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });
});
