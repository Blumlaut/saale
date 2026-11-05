import { test, expect, type Page } from "@playwright/test";

import { clearMailbox, seedMailbox } from "./fixtures";
import { gotoAndSettle } from "./utils";

/**
 * The inbox over a mailbox the app never synced.
 *
 * Two things here are easy to get wrong without noticing: the list pages with
 * `hasMore` (which a count used to answer by scanning the whole mailbox), and
 * the search box has to name the filter the route reads.
 *
 * Seeded rows: what is under test is the query and the list, not IMAP.
 */

/** More than the 25 the inbox asks for, so the list has a second page. */
const SEEDED = 30;

let accountId = "";
/** The inbox scoped to the seeded account, so the shared database cannot leak in. */
let inbox = "";

test.beforeAll(async () => {
  accountId = await seedMailbox(SEEDED);
  inbox = `/dashboard/mail?accountId=${accountId}`;
});

test.afterAll(async () => {
  await clearMailbox();
});

// One mailbox, filled once and emptied once: the tests read it in order rather
// than each spreading a copy across workers.
test.describe.configure({ mode: "serial" });

/** The message rows of the list, told apart from the account's folder chips. */
function row(page: Page, subject: string) {
  return page.getByText(subject, { exact: true });
}

test.describe("mail inbox", () => {
  test("lists a page of the newest mail, then the rest when asked", async ({ page }) => {
    await gotoAndSettle(page, inbox);

    await expect(row(page, `seeded mail ${SEEDED}`)).toBeVisible();
    // The oldest mail is on the page after the first, not on screen yet.
    await expect(row(page, "seeded mail 1")).toHaveCount(0);

    await page.getByRole("button", { name: "Load more" }).click();

    await expect(row(page, "seeded mail 1")).toBeVisible();
    await expect(page.getByRole("button", { name: "Load more" })).toHaveCount(0);
  });

  test("filters the list by what the search box says", async ({ page }) => {
    await gotoAndSettle(page, inbox);
    await expect(row(page, `seeded mail ${SEEDED}`)).toBeVisible();

    await page.getByPlaceholder("Search emails...").fill("seeded mail 7");

    // The one match stays; the neighbours go.
    await expect(row(page, "seeded mail 7")).toBeVisible();
    await expect(row(page, `seeded mail ${SEEDED}`)).toHaveCount(0);
    await expect(page.getByText("No emails match your search")).toHaveCount(0);
  });

  test("keeps the account's folders above the list", async ({ page }) => {
    await gotoAndSettle(page, inbox);

    // The inbox asks for the folder scan; the nav does not, and both render
    // the same account.
    await expect(page.getByRole("button", { name: "Inbox", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Sent", exact: true })).toBeVisible();
  });
});
