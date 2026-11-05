import { test, expect, type APIRequestContext } from "@playwright/test";

import { gotoAndSettle } from "./utils";

/**
 * The bell's "Mark all read".
 *
 * It rewrites the whole list, which is one pipeline against Redis rather than a
 * command per entry. Read back after a reload: the answer has to be stored, not
 * just painted.
 */

async function seedNotification(request: APIRequestContext): Promise<void> {
  const response = await request.post("/api/notifications", {
    data: { type: "job_completed", title: "e2e notice", message: "seeded by the suite" },
  });
  expect(response.ok()).toBe(true);
}

/** The bell's trigger, which is the button holding the bell icon. */
function bell(page: import("@playwright/test").Page) {
  return page.locator("button:has(svg.lucide-bell)").first();
}

/** The unread count badge on it, if any. */
function unreadBadge(page: import("@playwright/test").Page) {
  return bell(page).locator('span[class*="bg-destructive"]');
}

test.describe("notifications", () => {
  test("marks every notification read, and the next load agrees", async ({ page, request }) => {
    await seedNotification(request);

    await gotoAndSettle(page, "/dashboard/tasks");
    await expect(unreadBadge(page).first()).toBeVisible();

    await bell(page).click();
    await expect(page.getByText("Notifications", { exact: true }).last()).toBeVisible();
    await page.getByRole("button", { name: "Mark all read" }).click();

    // Nothing is unread, so the badge and the control that clears it are gone.
    await expect(unreadBadge(page)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Mark all read" })).toHaveCount(0);

    await page.reload();
    await gotoAndSettle(page, "/dashboard/tasks");
    await expect(bell(page)).toBeVisible();
    await expect(unreadBadge(page)).toHaveCount(0);
  });
});
