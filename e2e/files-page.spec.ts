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

    // Nothing is open, so the browser has the row to itself.
    const wide = (await shown(page, '[data-slot="file-browser"]').boundingBox())!;
    await expect(shown(page, '[data-slot="tabs-list"]')).toHaveCount(0);

    await page.locator(`button:has-text("${FILES_NOTES}")`).first().click();

    // Monaco, the editor this page keeps beside the browser.
    await expect(shown(page, ".monaco-editor")).toBeVisible({ timeout: 30_000 });
    // The editor takes its room back from the browser, which stays beside it.
    const narrow = (await shown(page, '[data-slot="file-browser"]').boundingBox())!;
    expect(narrow.width).toBeLessThan(wide.width - 100);
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

  test("keeps a second file open beside the first", async ({ browser }) => {
    const { context, page } = await openFiles(browser);

    await page.locator(`button:has-text("${FILES_NOTES}")`).first().click();
    await expect(shown(page, ".monaco-editor")).toBeVisible({ timeout: 30_000 });

    await page.locator('button:has-text(".gitconfig")').first().click();

    // Both files hold a tab, and going back to the first shows it again.
    const strip = shown(page, '[data-slot="tabs-list"]');
    await expect(strip.getByRole("tab", { name: FILES_NOTES })).toBeVisible();
    await expect(strip.getByRole("tab", { name: ".gitconfig" })).toBeVisible();

    await strip.getByRole("tab", { name: FILES_NOTES }).click();
    await expect(shown(page, `[aria-label="Download ${FILES_NOTES}"]`)).toBeVisible();

    // Closing the tab leaves the other one open.
    await shown(page, `[aria-label="Close ${FILES_NOTES}"]`).click();
    await expect(strip.getByRole("tab", { name: FILES_NOTES })).toHaveCount(0);
    await expect(strip.getByRole("tab", { name: ".gitconfig" })).toBeVisible();

    await context.close();
  });

  test("connects to a registered machine", async ({ browser }) => {
    const { context, page } = await openFiles(browser);

    await shown(page, '[aria-label="Connect to a server"]').click();

    const menu = page.locator('[role="menu"]:visible').first();
    const entry = menu.getByRole("menuitem", { name: /e2e-server/ });
    await expect(entry).toBeVisible();

    await entry.click();
    // The header says which workspace the browser is on, and how to leave it.
    await expect(shown(page, '[aria-label="Disconnect from e2e-server"]')).toBeVisible();

    await context.close();
  });

  test("opens a shell in a console tab", async ({ browser }) => {
    const { context, page } = await openFiles(browser);
    // Counted here, and handed on to the stub the page already has.
    const sizes: Array<{ cols: number; rows: number }> = [];
    await page.route(/\/api\/terminal\/resize/, async (route) => {
      sizes.push(route.request().postDataJSON() as { cols: number; rows: number });
      await route.fallback();
    });

    // The strip only exists once something is in the pane, so the console
    // arrives from the browser's toolbar.
    await shown(page, '[aria-label="Open the console"]').click();

    await expect(shown(page, ".xterm")).toBeVisible({ timeout: 30_000 });
    await expect(shownText(page, "Shell running")).toBeVisible();
    // The shell is told the panel's size, so a full-screen program fits it.
    await expect.poll(() => sizes.some((size) => size.cols > 2)).toBe(true);

    await context.close();
  });

  test("keeps the console's shell while a file is in front", async ({ browser }) => {
    const { context, page } = await openFiles(browser);

    await shown(page, '[aria-label="Open the console"]').click();
    await expect(shown(page, ".xterm")).toBeVisible({ timeout: 30_000 });

    // Tagged so coming back shows the same terminal: a remounted one would be a
    // new node, and its screen would be the replay rather than the session.
    for (const node of await page.locator(".xterm").all()) {
      await node.evaluate((element) => element.setAttribute("data-kept", "1"));
    }

    await page.locator(`button:has-text("${FILES_NOTES}")`).first().click();
    await expect(shown(page, ".monaco-editor")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".xterm:visible")).toHaveCount(0);

    await shown(page, '[data-slot="tabs-list"]').getByRole("tab", { name: "Console" }).click();
    await expect(shown(page, '.xterm[data-kept="1"]')).toBeVisible();
    await expect(shownText(page, "Shell running")).toBeVisible();

    await context.close();
  });

  test("gives the browser the row back when the console closes", async ({ browser }) => {
    const { context, page } = await openFiles(browser);

    await shown(page, '[aria-label="Open the console"]').click();
    await expect(shown(page, ".xterm")).toBeVisible({ timeout: 30_000 });
    const narrow = (await shown(page, '[data-slot="file-browser"]').boundingBox())!;

    await shown(page, '[aria-label="Close the console"]').click();

    await expect(shown(page, '[data-slot="tabs-list"]')).toHaveCount(0);
    const wide = (await shown(page, '[data-slot="file-browser"]').boundingBox())!;
    expect(wide.width).toBeGreaterThan(narrow.width + 100);

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
    await expect(page.locator('[aria-label="Select notes.md"]:visible')).toHaveCount(0);
    await shown(page, '[aria-label="Back to files"]').click();
    await expect(shown(page, `button:has-text("${FILES_NOTES}")`)).toBeVisible();

    await context.close();
  });
});
