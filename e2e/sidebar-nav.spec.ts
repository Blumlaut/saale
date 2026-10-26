import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";

import { bootstrapSession, type E2ESession } from "./utils";
import {
  SIDEBAR_NAV_ITEM_IDS,
  SIDEBAR_NAV_ITEMS,
  type SidebarNavItemId,
} from "@/lib/navigation/sidebar-nav";

/**
 * Sidebar customization.
 *
 * Drives the real settings editor against the real API: reordering and hiding
 * must be visible in the sidebar immediately *and* survive a reload, and the
 * layout must be shared by the desktop sidebar and the mobile bottom bar.
 *
 * The layout lives on the shared e2e user, so the file runs serially and resets
 * to the default before every test  otherwise one test's layout leaks into the
 * next one's assertions.
 */

const DESKTOP = { width: 1280, height: 900 };
const MOBILE = { width: 375, height: 667 };

/**
 * The default sidebar order.
 *
 * Opt-in items (Council) are registered but hidden until the user enables them,
 * so they are not part of the default order  `NAV_LABELS_ANY` is what a label
 * filter uses, so a visible Council item cannot slip past these assertions
 * unnoticed.
 */
const NAV_LABELS = [
  "Chat",
  "Mail",
  "Contacts",
  "Calendar",
  "Tasks",
  "Jobs",
  "Infrastructure",
  "Settings",
];
const NAV_LABELS_ANY = [...NAV_LABELS, "Council"];

let session: E2ESession | null = null;

test.describe.configure({ mode: "serial" });

async function resetLayout(browser: Browser): Promise<void> {
  if (!session) return;
  const ctx = await browser.newContext({ storageState: session.storageState });
  const res = await ctx.request.patch("/api/settings/sidebar-nav", { data: { items: null } });
  if (!res.ok()) console.warn(`e2e: sidebar layout reset failed (${res.status()})`);
  await ctx.close();
}

test.beforeAll(async ({ browser, request }) => {
  session = await bootstrapSession(browser, request);
});

test.beforeEach(async ({ browser }) => {
  await resetLayout(browser);
});

test.afterAll(async ({ browser }) => {
  await resetLayout(browser);
});

/** The desktop sidebar's item labels, top to bottom. */
async function sidebarOrder(page: Page): Promise<string[]> {
  return page.locator("nav.sidebar-nav").evaluate((nav, labels) => {
    return [...nav.querySelectorAll("a, button")]
      .map((element) => (element.textContent ?? "").trim())
      .filter((text) => labels.includes(text));
  }, NAV_LABELS_ANY);
}

/** Row index in the editor, which lists the whole registry including hidden items. */
function rowIndex(id: SidebarNavItemId): number {
  const index = SIDEBAR_NAV_ITEMS.findIndex((item) => item.id === id);
  if (index === -1) throw new Error(`e2e: ${id} is not a sidebar item`);
  return index;
}

/** An item of the desktop sidebar. Every row is a link, the section toggle beside it. */
function sidebarItem(page: Page, label: string) {
  return page.locator("nav.sidebar-nav").getByRole("link", { name: label, exact: true });
}

/** Labels of the items in the mobile bottom bar, left to right. */
async function mobileNavLabels(page: Page): Promise<string[]> {
  const bar = page.locator("nav.md\\:hidden");
  await expect(bar).toBeVisible();
  return (await bar.locator("a").allInnerTexts()).map((label) => label.trim());
}

/** The visible item ids as the server stores them  proves a save landed. */
async function persistedIds(ctx: BrowserContext): Promise<string[]> {
  const res = await ctx.request.get("/api/settings/sidebar-nav");
  const { items } = (await res.json()) as { items: { id: string; hidden: boolean }[] };
  return items.filter((item) => !item.hidden).map((item) => item.id);
}

/** Open Settings → Appearance and wait for the sidebar editor. */
async function openAppearance(page: Page) {
  if (!page.url().endsWith("/dashboard/settings/appearance")) {
    await page.goto("/dashboard/settings/appearance", { waitUntil: "domcontentloaded" });
  }
  await expect(page.getByRole("heading", { name: "Sidebar" })).toBeVisible();
}

test.describe("sidebar customization", () => {
  test("reorders an item with the arrow buttons and keeps it after a reload", async ({
    browser,
  }) => {
    test.skip(!session, "login failed");
    const ctx = await browser.newContext({
      viewport: DESKTOP,
      storageState: session!.storageState,
    });
    const page = await ctx.newPage();
    await page.goto("/dashboard/settings", { waitUntil: "domcontentloaded" });

    expect(await sidebarOrder(page)).toEqual(NAV_LABELS);

    await openAppearance(page);
    // The layout also holds hidden items, so Settings needs as many clicks as
    // the registry has entries above it. Click until it reaches the top.
    const moveUp = page.getByRole("button", { name: "Move Settings up" });
    for (let i = 0; i < 20 && !(await moveUp.isDisabled()); i++) {
      await moveUp.click();
    }

    // Settings is first now  in the editor and in the sidebar itself.
    await expect(page.getByRole("button", { name: "Move Settings up" })).toBeDisabled();
    await expect
      .poll(() => persistedIds(ctx))
      .toEqual(["settings", "chat", "mail", "contacts", "calendar", "tasks", "jobs", "infra"]);

    const reordered = [
      "Settings",
      "Chat",
      "Mail",
      "Contacts",
      "Calendar",
      "Tasks",
      "Jobs",
      "Infrastructure",
    ];
    await expect.poll(() => sidebarOrder(page)).toEqual(reordered);

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect.poll(() => sidebarOrder(page)).toEqual(reordered);

    await ctx.close();
  });

  test("reorders an item by dragging it", async ({ browser }) => {
    test.skip(!session, "login failed");
    const ctx = await browser.newContext({
      viewport: DESKTOP,
      storageState: session!.storageState,
    });
    const page = await ctx.newPage();
    await openAppearance(page);

    const rows = page.locator('div[draggable="true"]');
    await expect(rows).toHaveCount(SIDEBAR_NAV_ITEMS.length);
    // Drag Tasks onto Chat.
    await rows.nth(rowIndex("tasks")).dragTo(rows.nth(rowIndex("chat")));

    await expect(page.getByRole("button", { name: "Move Tasks up" })).toBeDisabled();
    await expect
      .poll(() => sidebarOrder(page))
      .toEqual([
        "Tasks",
        "Chat",
        "Mail",
        "Contacts",
        "Calendar",
        "Jobs",
        "Infrastructure",
        "Settings",
      ]);

    await ctx.close();
  });

  test("hides an item from the desktop sidebar and the mobile bar", async ({ browser }) => {
    test.skip(!session, "login failed");
    const ctx = await browser.newContext({
      viewport: DESKTOP,
      storageState: session!.storageState,
    });
    const page = await ctx.newPage();
    await openAppearance(page);

    await page.getByRole("switch", { name: "Show Mail in the sidebar" }).click();

    // Stored before the phone opens it  the desktop sidebar applies edits optimistically.
    await expect
      .poll(() => persistedIds(ctx))
      .toEqual(["chat", "contacts", "calendar", "tasks", "jobs", "infra", "settings"]);

    await expect
      .poll(() => sidebarOrder(page))
      .toEqual(["Chat", "Contacts", "Calendar", "Tasks", "Jobs", "Infrastructure", "Settings"]);
    await expect(sidebarItem(page, "Mail")).toHaveCount(0);
    await ctx.close();

    // Same layout on a phone: the bottom bar drops the item and keeps the order.
    const mobile = await browser.newContext({
      viewport: MOBILE,
      storageState: session!.storageState,
    });
    const mobilePage = await mobile.newPage();
    await mobilePage.goto("/dashboard/chat", { waitUntil: "domcontentloaded" });

    // Admins get the Admin item appended to the bar  it's not part of the layout.
    const me = (await (await mobile.request.get("/api/auth/get-session")).json()) as {
      user?: { role?: string };
    };
    const expectedLabels = ["Chat", "Contacts", "Calendar", "Tasks", "Jobs", "Servers", "Settings"];
    if (me.user?.role === "admin") expectedLabels.push("Admin");

    // The bar renders the default layout until the stored one arrives  poll.
    await expect.poll(() => mobileNavLabels(mobilePage)).toEqual(expectedLabels);
    await mobile.close();
  });

  test("reflects a layout saved elsewhere and restores the default on reset", async ({
    browser,
  }) => {
    test.skip(!session, "login failed");
    const ctx = await browser.newContext({
      viewport: DESKTOP,
      storageState: session!.storageState,
    });
    const page = await ctx.newPage();

    const res = await ctx.request.patch("/api/settings/sidebar-nav", {
      data: {
        items: [
          { id: "tasks", hidden: true },
          { id: "chat", hidden: false },
        ],
      },
    });
    expect(res.status()).toBe(200);
    const { items } = (await res.json()) as { items: { id: string; hidden: boolean }[] };
    // Items the layout doesn't mention keep showing, appended after the ordered ones.
    expect(items).toHaveLength(SIDEBAR_NAV_ITEMS.length);
    expect(items.find((item) => item.id === "tasks")?.hidden).toBe(true);
    expect(items.find((item) => item.id === "calendar")?.hidden).toBe(false);

    await openAppearance(page);
    await expect(page.getByRole("switch", { name: "Show Tasks in the sidebar" })).not.toBeChecked();
    await expect(sidebarItem(page, "Tasks")).toHaveCount(0);

    await page.getByRole("button", { name: "Reset" }).click();

    // Only the editor's rows: the appearance page has switches of its own.
    const switches = page.locator('div[draggable="true"]').getByRole("switch");
    await expect(switches).toHaveCount(SIDEBAR_NAV_ITEMS.length);
    for (const item of await switches.all()) {
      // The opt-in items start hidden, so only the everyday ones are on.
      const optIn = (await item.getAttribute("aria-label"))?.match(/^Show (\w+) in the sidebar$/);
      if (optIn && (optIn[1] === "Coder" || optIn[1] === "Council")) continue;
      await expect(item).toBeChecked();
    }
    await expect(page.getByRole("button", { name: "Reset" })).toBeDisabled();
    await expect.poll(() => sidebarOrder(page)).toEqual(NAV_LABELS);

    await ctx.close();
  });

  test("keeps the last visible item from being hidden", async ({ browser }) => {
    test.skip(!session, "login failed");
    const ctx = await browser.newContext({
      viewport: DESKTOP,
      storageState: session!.storageState,
    });
    const page = await ctx.newPage();

    const res = await ctx.request.patch("/api/settings/sidebar-nav", {
      // Everything hidden but Chat, whatever the registry holds today.
      data: { items: SIDEBAR_NAV_ITEM_IDS.map((id) => ({ id, hidden: id !== "chat" })) },
    });
    expect(res.status()).toBe(200);

    await openAppearance(page);
    const chatSwitch = page.getByRole("switch", { name: "Show Chat in the sidebar" });
    await expect(chatSwitch).toBeDisabled();
    await expect(page.getByRole("switch", { name: "Show Mail in the sidebar" })).toBeEnabled();
    // Settings itself can never be hidden  it's the only place the layout is edited.
    await expect(page.getByRole("switch", { name: "Show Settings in the sidebar" })).toBeDisabled();

    // The server coerces hidden pinned items back to visible, too.
    const coerced = await ctx.request.patch("/api/settings/sidebar-nav", {
      data: { items: [{ id: "chat", hidden: true }] },
    });
    expect(coerced.status()).toBe(200);
    const { items: coercedItems } = (await coerced.json()) as {
      items: { id: string; hidden: boolean }[];
    };
    expect(coercedItems.find((item) => item.id === "settings")?.hidden).toBe(false);
    expect(coercedItems.find((item) => item.id === "chat")?.hidden).toBe(true);
    await expect(chatSwitch).toBeDisabled();

    await ctx.close();
  });

  test("fits the editor on a 320px screen", async ({ browser }) => {
    test.skip(!session, "login failed");
    const phone = await browser.newContext({
      viewport: { width: 320, height: 667 },
      storageState: session!.storageState,
    });
    const phonePage = await phone.newPage();
    await openAppearance(phonePage);

    // No horizontal overflow, and every row stays reachable by scrolling.
    const overflow = await phonePage.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(2);

    const lastRow = phonePage.getByRole("switch", { name: "Show Settings in the sidebar" });
    await lastRow.scrollIntoViewIfNeeded();
    await expect(lastRow).toBeVisible();
    await expect(phonePage.getByRole("button", { name: "Move Settings up" })).toBeInViewport();

    await phone.close();
  });
});
