import { test, expect, type Browser, type Page } from "@playwright/test";

import { gotoAndSettle, sessionContext } from "./utils";
import { FILES_NOTES, FILES_ROOT, mockFiles } from "./files-mocks";

/**
 * The files page: a workspace with room for an editor.
 *
 * The file API is stubbed, because what this page does with a workspace is the
 * part a unit test cannot see: two panels side by side, one of them on a phone,
 * and a row menu that answers a right click as well as its own button.
 */

/**
 * The on-screen copy of an element.
 *
 * The app shell renders the page once per shell and hides one with CSS, so every
 * locator matches twice.
 */
function shown(page: Page, selector: string) {
  return page.locator(`${selector}:visible`).first();
}

/** The on-screen copy of an element found by its text. */
function shownText(page: Page, text: string) {
  return page.locator(`text=${text}`).filter({ visible: true }).first();
}

async function openFiles(browser: Browser, viewport?: { width: number; height: number }) {
  const context = await sessionContext(browser, viewport ? { viewport } : {});
  const page = await context.newPage();
  await mockFiles(page);
  await gotoAndSettle(page, "/dashboard/files");
  return { context, page };
}

test.describe("files page", () => {
  test("opens a file in the editor beside the browser", async ({ browser }) => {
    const { context, page } = await openFiles(browser);

    await expect(shownText(page, "No file open")).toBeVisible();
    await page.locator(`button:has-text("${FILES_NOTES}")`).first().click();

    // Monaco, the editor this page keeps beside the browser.
    await expect(shown(page, ".monaco-editor")).toBeVisible({ timeout: 30_000 });
    await expect(shown(page, `[aria-label="Download ${FILES_NOTES}"]`)).toBeVisible();
    await expect(page.locator('[role="dialog"]:visible')).toHaveCount(0);
    // The browser stays beside it: this is the room the page exists for.
    await expect(shown(page, `button:has-text("${FILES_NOTES}")`)).toBeVisible();

    await context.close();
  });

  test("opens the row menu on right click", async ({ browser }) => {
    const { context, page } = await openFiles(browser);

    await page.locator(`button:has-text("${FILES_NOTES}")`).first().click({ button: "right" });

    const menu = page.locator('[role="menu"]:visible').first();
    await expect(menu).toBeVisible();
    for (const item of ["Open", "Select", "Download", "Rename", "Delete"]) {
      await expect(menu.getByRole("menuitem", { name: item, exact: true })).toBeVisible();
    }

    await menu.getByRole("menuitem", { name: "Select", exact: true }).click();
    await expect(shownText(page, "1 selected")).toBeVisible();

    // The same menu says the opposite once the row is selected.
    await page.locator(`button:has-text("${FILES_NOTES}")`).first().click({ button: "right" });
    await expect(
      page.locator('[role="menu"]:visible').first().getByRole("menuitem", { name: "Deselect" }),
    ).toBeVisible();

    await context.close();
  });

  test("shows a config file with no extension as text", async ({ browser }) => {
    const { context, page } = await openFiles(browser);

    await page.locator('button:has-text(".gitconfig")').first().click();

    await expect(shown(page, ".monaco-editor")).toBeVisible({ timeout: 30_000 });
    await expect(
      page.locator("text=This file cannot be shown here").filter({ visible: true }),
    ).toHaveCount(0);

    await context.close();
  });

  test("refuses a file whose bytes are not text, whatever its name", async ({ browser }) => {
    const { context, page } = await openFiles(browser);

    await page.locator('button:has-text("misnamed.md")').first().click();

    await expect(
      page.locator("text=This file cannot be shown here").filter({ visible: true }),
    ).toBeVisible();
    await expect(page.locator(".monaco-editor:visible")).toHaveCount(0);

    await context.close();
  });

  test("creates an empty file from the toolbar", async ({ browser }) => {
    const created: { path: string; name: string }[] = [];
    const { context, page } = await openFiles(browser);
    await page.route(/\/api\/files\/create/, async (route) => {
      const body = route.request().postDataJSON() as { path: string; name: string };
      created.push(body);
      await route.fulfill({ json: { path: `${body.path}/${body.name}` } });
    });

    await shown(page, '[aria-label="More actions"]').click();
    await page.getByRole("menuitem", { name: "New file" }).click();
    await shown(page, "#file-prompt-name").fill("roadmap.md");
    await shown(page, 'button:has-text("Create file")').click();

    await expect.poll(() => created.length).toBe(1);
    expect(created[0]).toEqual({ path: FILES_ROOT, name: "roadmap.md" });

    await context.close();
  });

  test("gives the editor the whole screen on a phone", async ({ browser }) => {
    const { context, page } = await openFiles(browser, { width: 375, height: 667 });

    await page.locator(`button:has-text("${FILES_NOTES}")`).first().click();

    await expect(shown(page, ".monaco-editor")).toBeVisible({ timeout: 30_000 });
    // One panel at a time: the browser steps aside until the back arrow asks.
    await expect(page.locator(`button:has-text("${FILES_NOTES}"):visible`)).toHaveCount(0);
    await shown(page, '[aria-label="Back to files"]').click();
    await expect(shown(page, `button:has-text("${FILES_NOTES}")`)).toBeVisible();

    await context.close();
  });
});
