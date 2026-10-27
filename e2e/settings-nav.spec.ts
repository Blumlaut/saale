import { test, expect, type Page } from "@playwright/test";

import { sessionContext } from "./utils";
import { SETTINGS_ROOT } from "@/lib/navigation/settings-nav";

/**
 * Settings navigation.
 *
 * Settings used to carry its own tab strip above the content. It is part of the
 * sidebar now: every section is a route, `/dashboard/settings` lands on the
 * default one, old `?tab=` links still resolve, and the sidebar names the
 * section the user is on.
 */

/** The sidebar item for a settings section. */
function sidebarSection(page: Page, label: string) {
  return page.locator("nav.sidebar-nav").getByRole("link", { name: label, exact: true });
}

test.describe("settings navigation", () => {
  test("lands on a section instead of a bare settings URL", async ({ browser }) => {
    const ctx = await sessionContext(browser, { viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();

    await page.goto(SETTINGS_ROOT, { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(/\/dashboard\/settings\/[a-z]+$/);
    // No tab strip: the sidebar is the only navigation in settings.
    await expect(page.getByRole("tablist")).toHaveCount(0);

    await ctx.close();
  });

  test("marks the current section in the sidebar", async ({ browser }) => {
    const ctx = await sessionContext(browser, { viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();

    // One per group: the sidebar nests the sections under Settings, and the one
    // the page belongs to is marked. `settings-nav.test.ts` covers the rest of
    // the registry against the route files.
    for (const section of [
      { href: `${SETTINGS_ROOT}/appearance`, label: "Appearance" },
      { href: `${SETTINGS_ROOT}/models`, label: "Models" },
      { href: `${SETTINGS_ROOT}/security`, label: "Security" },
    ]) {
      await page.goto(section.href, { waitUntil: "domcontentloaded" });
      await expect(sidebarSection(page, section.label)).toHaveAttribute("aria-current", "page");
    }

    await ctx.close();
  });

  test("still resolves the old ?tab= links", async ({ browser }) => {
    const ctx = await sessionContext(browser, { viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();

    await page.goto(`${SETTINGS_ROOT}?tab=memories`, { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(/\/dashboard\/settings\/memories$/);
    await expect(page.getByRole("button", { name: "Add Memory" })).toBeVisible();

    await ctx.close();
  });

  test("falls back to the default section for an unknown tab", async ({ browser }) => {
    const ctx = await sessionContext(browser, { viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();

    await page.goto(`${SETTINGS_ROOT}?tab=bogus`, { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(/\/dashboard\/settings\/profile$/);

    await ctx.close();
  });
});
