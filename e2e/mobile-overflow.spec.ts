import { test, expect } from "@playwright/test";

/**
 * Catch horizontal overflow regressions on mobile.
 *
 * Runs each dashboard route at iPhone SE dimensions (375×667) and asserts
 * the page width never exceeds the viewport.  Fails fast so a single
 * offending component blocks the pipeline.
 */
test.describe("mobile overflow", () => {
  const mobilePages = [
    "/dashboard/chat",
    "/dashboard/mail",
    "/dashboard/calendar",
    "/dashboard/tasks",
    "/dashboard/settings",
  ];

  for (const path of mobilePages) {
    test(`${path} has no horizontal overflow at 375px`, async ({ page }) => {
      await page.setViewportSize({ width: 375, height: 667 });
      await page.goto(path);
      await page.waitForLoadState("networkidle");

      // Small grace period for lazy transitions / animations to settle
      await page.waitForTimeout(300);

      const overflow = await page.evaluate(() => {
        return document.documentElement.scrollWidth > window.innerWidth + 2; // 2px tolerance
      });

      expect(overflow, `Page ${path} overflows horizontally at 375px width`).toBe(false);
    });
  }
});
