import { test, expect } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";

import { settingsSection } from "@/lib/navigation/settings-nav";
import { gotoAndSettle } from "./utils";
import { openRowMenu } from "./modal-scenarios";

/**
 * The shared delete confirmation, driven from a real list.
 *
 * Every row menu on the app routes its delete through `ConfirmDialog`, so the
 * one thing worth guarding end to end is the order: nothing is sent until the
 * box is confirmed, and a refused delete keeps the box with its reason.
 */

const API = "/api/tasks";

async function createTask(request: APIRequestContext, title: string): Promise<string> {
  const response = await request.post(API, { data: { title } });
  expect(response.status()).toBeLessThan(400);
  const body = (await response.json()) as { task: { id: string } };
  return body.task.id;
}

/** Delete what the test made; a task that is already gone answers 404 and is fine. */
async function discardTask(request: APIRequestContext, id: string) {
  await request.delete(`${API}/${id}`);
}

/** The list row carrying a title; the confirmation repeats the title in its heading. */
function row(page: Page, title: string) {
  return page.getByText(title, { exact: true });
}

/** Every DELETE the page sent, so an assertion can say "none yet". */
function trackDeletes(page: Page): string[] {
  const sent: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "DELETE") sent.push(request.url());
  });
  return sent;
}

test.describe("delete confirmation", () => {
  test("sends nothing until the box is confirmed, then removes the row", async ({
    page,
    request,
  }) => {
    const title = `Delete me ${Date.now()}`;
    const id = await createTask(request, title);
    const deletes = trackDeletes(page);

    try {
      await gotoAndSettle(page, "/dashboard/tasks", { quietNetwork: true });
      await expect(row(page, title)).toBeVisible();

      await openRowMenu(page, title);
      await page.getByRole("menuitem", { name: "Delete" }).click();

      const box = page.getByRole("alertdialog");
      await expect(box).toContainText(`Delete “${title}”?`);
      expect(deletes).toHaveLength(0);

      await box.getByRole("button", { name: "Cancel" }).click();
      await expect(box).toHaveCount(0);
      expect(deletes).toHaveLength(0);
      await expect(page.getByText(title)).toBeVisible();

      await openRowMenu(page, title);
      await page.getByRole("menuitem", { name: "Delete" }).click();
      await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();

      await expect(box).toHaveCount(0);
      await expect(row(page, title)).toHaveCount(0);
      expect(deletes.filter((url) => url.endsWith(`/api/tasks/${id}`))).toHaveLength(1);
    } finally {
      await discardTask(request, id);
    }
  });

  test("keeps the box open with the reason the delete was refused", async ({ page, request }) => {
    const title = `Keep me ${Date.now()}`;
    const id = await createTask(request, title);

    try {
      await page.route(`${API}/${id}`, (route) =>
        route.request().method() === "DELETE"
          ? route.fulfill({ status: 500, json: { error: "The database is unreachable." } })
          : route.continue(),
      );

      await gotoAndSettle(page, "/dashboard/tasks", { quietNetwork: true });
      await openRowMenu(page, title);
      await page.getByRole("menuitem", { name: "Delete" }).click();
      await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();

      const box = page.getByRole("alertdialog");
      await expect(box).toBeVisible();
      await expect(box).toContainText("The database is unreachable.");
      await expect(row(page, title)).toBeVisible();
    } finally {
      await page.unrouteAll({ behavior: "ignoreErrors" });
      await discardTask(request, id);
    }
  });
});

/**
 * A settings card, where the box comes from the card rather than a row menu and
 * nothing is listed after the delete but the rest of the settings.
 */
test.describe("delete confirmation on a settings card", () => {
  test("removes an environment variable only after the box is confirmed", async ({ page }) => {
    const name = "E2E_CONFIRMED_TOKEN";
    const sent: string[] = [];
    await page.route(/\/api\/settings\/sandbox-env(\?|$)/, (route) => {
      if (route.request().method() === "GET") return route.fulfill({ json: { names: [name] } });
      if (route.request().method() === "DELETE") {
        sent.push(route.request().url());
        return route.fulfill({ json: { names: [] } });
      }
      return route.fallback();
    });

    await gotoAndSettle(page, "/dashboard/settings/integrations", { quietNetwork: true });
    const remove = page.getByRole("button", { name: `Remove ${name}` }).filter({ visible: true });
    await remove.click();

    const box = page.getByRole("alertdialog");
    await expect(box).toContainText(`Remove ${name}?`);
    expect(sent).toHaveLength(0);

    await box.getByRole("button", { name: "Remove" }).click();

    await expect(box).toHaveCount(0);
    await expect(remove).toHaveCount(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain(`name=${name}`);
  });
});

/**
 * The one surface where the box asks about something other than a delete, and a
 * sync that fails reports itself: the email section.
 */
test.describe("delete confirmation in the email section", () => {
  const ACCOUNT = {
    id: "e2e-account",
    email: "someone@example.com",
    enabled: true,
    messageCount: 12,
    lastSyncedAt: null,
    lastSyncError: null,
  };

  test("re-downloading every message asks first and reports its own failure", async ({ page }) => {
    const calls: string[] = [];
    await page.route(/\/api\/email\/accounts/, (route) => {
      if (route.request().method() === "GET") {
        return route.fulfill({ json: { accounts: [ACCOUNT] } });
      }
      calls.push(route.request().url());
      return route.fulfill({ status: 500, json: { error: "The mail server refused the login." } });
    });

    await gotoAndSettle(page, settingsSection("email").href, { quietNetwork: true });
    await expect(page.getByText(ACCOUNT.email, { exact: true })).toBeVisible();
    await page.getByRole("button", { name: `Actions for ${ACCOUNT.email}` }).click();
    await page.getByRole("menuitem", { name: "Full Refresh" }).click();

    const box = page.getByRole("alertdialog");
    await expect(box).toContainText(`Re-download every message in ${ACCOUNT.email}?`);
    expect(calls).toHaveLength(0);

    await box.getByRole("button", { name: "Continue" }).click();

    await expect(box).toContainText("The mail server refused the login.");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("/full-refresh");
  });
});

/**
 * The calendar section, where the same box removes an account and a feed, and a
 * sync that failed reports itself instead.
 */
test.describe("delete confirmation in the calendar section", () => {
  const ACCOUNT = {
    id: "e2e-calendar",
    name: "someone@example.com",
    enabled: true,
    accountType: "caldav",
    username: "someone@example.com",
    calendars: [
      {
        id: "e2e-calendar-1",
        name: "Personal",
        color: "#f97316",
        enabled: true,
        remoteId: "e2e-calendar-1",
      },
    ],
  };
  const FEED = {
    id: "e2e-feed",
    name: "Holidays",
    url: "https://example.com/holidays.ics",
    calendarId: "e2e-feed",
    calendarName: "Holidays",
    calendarColor: null,
    enabled: true,
    lastSyncedAt: null,
  };

  test("removing an account waits for the box and sends one request", async ({ page }) => {
    const calls: string[] = [];
    await page.route(/\/api\/calendar\/(accounts|subscriptions)/, (route) => {
      const request = route.request();
      if (request.method() === "GET") {
        return route.fulfill({
          json: request.url().includes("subscriptions")
            ? { subscriptions: [FEED] }
            : { accounts: [ACCOUNT] },
        });
      }
      calls.push(`${request.method()} ${request.url()}`);
      return route.fulfill({ json: {} });
    });

    await gotoAndSettle(page, settingsSection("calendar").href, { quietNetwork: true });
    const menu = page.getByRole("button", { name: `Actions for ${ACCOUNT.name}` });
    await menu.click();
    await page.getByRole("menuitem", { name: "Delete Account" }).click();

    const box = page.getByRole("alertdialog");
    await expect(box).toContainText(`Delete the ${ACCOUNT.name} account?`);
    expect(calls).toHaveLength(0);

    await box.getByRole("button", { name: "Cancel" }).click();
    await expect(box).toHaveCount(0);
    expect(calls).toHaveLength(0);

    await menu.click();
    await page.getByRole("menuitem", { name: "Delete Account" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();

    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain(`/api/calendar/accounts/${ACCOUNT.id}`);
  });

  test("removing a feed from its form lets the form close before the box opens", async ({
    page,
  }) => {
    const calls: string[] = [];
    await page.route(/\/api\/calendar\/(accounts|subscriptions)/, (route) => {
      const request = route.request();
      if (request.method() === "GET") {
        return route.fulfill({
          json: request.url().includes("subscriptions")
            ? { subscriptions: [FEED] }
            : { accounts: [ACCOUNT] },
        });
      }
      calls.push(`${request.method()} ${request.url()}`);
      return route.fulfill({ json: {} });
    });

    await gotoAndSettle(page, settingsSection("calendar").href, { quietNetwork: true });
    await page.getByRole("button", { name: `Actions for ${FEED.name}` }).click();
    await page.getByRole("menuitem", { name: "Edit" }).click();
    await expect(page.getByRole("dialog")).toContainText("Edit ICS Subscription");

    await page.getByRole("dialog").getByRole("button", { name: "Remove" }).click();

    const box = page.getByRole("alertdialog");
    await expect(box).toContainText(`Remove ${FEED.name}?`);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(calls).toHaveLength(0);

    await box.getByRole("button", { name: "Cancel" }).click();
    await expect(box).toHaveCount(0);
    expect(calls).toHaveLength(0);
  });
});
