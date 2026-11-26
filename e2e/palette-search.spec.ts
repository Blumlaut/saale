import { test, expect } from "@playwright/test";

import { gotoAndSettle } from "./utils";

/**
 * The ⌘K palette reaches every source, and a row lands on the row it names.
 *
 * A task is the fixture: seeded over HTTP, found through the palette, and its
 * form has to be the thing that opens. The palette's own list is the only place
 * these kinds of row are rendered, so this is where a broken `href` shows.
 */

/** Open the sidebar's search box, the way a click on it does. */
async function openPalette(page: import("@playwright/test").Page): Promise<void> {
  await page
    .getByRole("button", { name: /Search\.\.\./ })
    .first()
    .click();
}

test.describe("the ⌘K palette", () => {
  test("finds a task and opens it", async ({ page, request }) => {
    const title = `palette task ${Date.now()}`;
    const created = await request.post("/api/tasks", { data: { title } });
    expect(created.ok()).toBe(true);
    const { task } = await created.json();

    try {
      await gotoAndSettle(page, "/dashboard/tasks");
      await openPalette(page);

      await page.getByPlaceholder("Search chats, mail, tasks...").fill(title);

      // The row carries the kind it found, so the list says what it is.
      const row = page.getByRole("button", { name: new RegExp(title) }).first();
      await expect(row).toBeVisible();
      await expect(row.getByText("task", { exact: true })).toBeVisible();

      await row.click();

      // The task's own form is what the link names, already filled in.
      const dialog = page.getByRole("dialog");
      await expect(dialog.getByRole("heading", { name: "Edit Task" })).toBeVisible();
      await expect(dialog.getByPlaceholder("What needs to be done?")).toHaveValue(title);
    } finally {
      await request.delete(`/api/tasks/${task.id}`);
    }
  });
});
