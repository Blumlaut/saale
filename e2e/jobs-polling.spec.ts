import { test, expect } from "@playwright/test";

import { gotoAndSettle } from "./utils";

/**
 * What the scheduled jobs list costs when nothing is happening.
 *
 * The scheduler starts runs the page cannot see, so it polls for one. A run's
 * progress is worth a short interval; waiting for a start is not, and a hidden
 * tab is worth nothing at all.
 */

/** Long enough to cover the running interval (5s) and not the idle one (30s). */
const QUIET_WINDOW_MS = 7000;

test.describe("jobs list polling", () => {
  test("does not re-read the list while no run is in flight", async ({ page }) => {
    const listReads: number[] = [];
    page.on("request", (request) => {
      const url = request.url();
      if (request.method() === "GET" && /\/api\/jobs$/.test(url)) listReads.push(Date.now());
    });

    await gotoAndSettle(page, "/dashboard/jobs/scheduled");
    await expect(page.getByRole("button", { name: /Add|New job/i }).first()).toBeVisible();
    await expect.poll(() => listReads.length).toBeGreaterThan(0);

    const readsAfterLoad = listReads.length;
    await page.waitForTimeout(QUIET_WINDOW_MS);

    // An idle list used to poll every 5 seconds regardless.
    expect(listReads.length).toBe(readsAfterLoad);
  });
});
