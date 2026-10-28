import { test, expect, type Browser, type Page } from "@playwright/test";

import { gotoAndSettle, sessionContext } from "./utils";

/**
 * The files page: a workspace with room for an editor.
 *
 * The file API is stubbed, because what this page does with a workspace is the
 * part a unit test cannot see: two panels side by side, one of them on a phone,
 * and a row menu that answers a right click as well as its own button.
 */

const ROOT = "/workspaces/user-e2e";

const LISTING = {
  target: {
    id: "user",
    label: "Your files",
    root: ROOT,
    capabilities: { upload: true, createDirectory: true, rename: true, remove: true },
  },
  path: ROOT,
  truncated: false,
  entries: [
    {
      name: "src",
      path: `${ROOT}/src`,
      kind: "directory",
      size: 4096,
      modified: 1_791_904_714_445,
      writable: true,
    },
    {
      name: "notes.md",
      path: `${ROOT}/notes.md`,
      kind: "file",
      size: 128,
      modified: 1_791_904_714_445,
      writable: true,
    },
  ],
};

async function mockFiles(page: Page) {
  await page.route(/\/api\/files\/list/, (route) => route.fulfill({ json: LISTING }));
  await page.route(/\/api\/files\/raw/, (route) =>
    route.fulfill({ body: "# e2e notes\n", contentType: "text/markdown; charset=utf-8" }),
  );
  await page.route(/\/api\/files\/write/, (route) => route.fulfill({ json: { modified: 1 } }));
  await page.route(/\/api\/files\/zip/, (route) =>
    route.fulfill({ status: 200, contentType: "application/zip", body: "" }),
  );
}

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
    await page.locator('button:has-text("notes.md")').first().click();

    // Monaco, not the sheet the council files page opens.
    await expect(shown(page, ".monaco-editor")).toBeVisible({ timeout: 30_000 });
    await expect(shown(page, '[aria-label="Download notes.md"]')).toBeVisible();
    await expect(page.locator('[role="dialog"]:visible')).toHaveCount(0);
    // The browser stays beside it: this is the room the page exists for.
    await expect(shown(page, 'button:has-text("notes.md")')).toBeVisible();

    await context.close();
  });

  test("opens the row menu on right click", async ({ browser }) => {
    const { context, page } = await openFiles(browser);

    await page.locator('button:has-text("notes.md")').first().click({ button: "right" });

    const menu = page.locator('[role="menu"]:visible').first();
    await expect(menu).toBeVisible();
    for (const item of ["Open", "Select", "Download", "Rename", "Delete"]) {
      await expect(menu.getByRole("menuitem", { name: item, exact: true })).toBeVisible();
    }

    await menu.getByRole("menuitem", { name: "Select", exact: true }).click();
    await expect(shownText(page, "1 selected")).toBeVisible();

    // The same menu says the opposite once the row is selected.
    await page.locator('button:has-text("notes.md")').first().click({ button: "right" });
    await expect(
      page.locator('[role="menu"]:visible').first().getByRole("menuitem", { name: "Deselect" }),
    ).toBeVisible();

    await context.close();
  });

  test("gives the editor the whole screen on a phone", async ({ browser }) => {
    const { context, page } = await openFiles(browser, { width: 375, height: 667 });

    await page.locator('button:has-text("notes.md")').first().click();

    await expect(shown(page, ".monaco-editor")).toBeVisible({ timeout: 30_000 });
    // One panel at a time: the browser steps aside until the back arrow asks.
    await expect(page.locator('button:has-text("notes.md"):visible')).toHaveCount(0);
    await shown(page, '[aria-label="Back to files"]').click();
    await expect(shown(page, 'button:has-text("notes.md")')).toBeVisible();

    await context.close();
  });
});
