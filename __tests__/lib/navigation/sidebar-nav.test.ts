import { describe, it, expect } from "vitest";
import {
  SIDEBAR_NAV_ITEMS,
  SIDEBAR_NAV_ITEM_IDS,
  defaultSidebarNav,
  isDefaultSidebarNav,
  isSidebarNavActive,
  isSidebarNavItemId,
  moveSidebarNavEntry,
  normalizeSidebarNav,
  sidebarNavItem,
  visibleSidebarNavItems,
  type SidebarNavEntry,
} from "@/lib/navigation/sidebar-nav";
import { SIDEBAR_NAV_ICONS } from "@/components/layout/sidebar-nav-icons";

function ids(entries: SidebarNavEntry[]): string[] {
  return entries.map((entry) => entry.id);
}

function visibleIds(entries: SidebarNavEntry[]): string[] {
  return entries.filter((entry) => !entry.hidden).map((entry) => entry.id);
}

describe("sidebar nav registry", () => {
  it("exposes every id in the default order", () => {
    expect(ids(defaultSidebarNav())).toEqual([...SIDEBAR_NAV_ITEM_IDS]);
    expect(defaultSidebarNav().every((entry) => !entry.hidden)).toBe(true);
  });

  it("has an icon for every registry item", () => {
    for (const item of SIDEBAR_NAV_ITEMS) {
      expect(SIDEBAR_NAV_ICONS[item.id], `${item.id} has no icon`).toBeDefined();
    }
  });

  it("describes every item with a route and a label", () => {
    for (const item of SIDEBAR_NAV_ITEMS) {
      expect(item.href).toBe(`/dashboard/${item.id}`);
      expect(item.label.length).toBeGreaterThan(0);
    }
    expect(sidebarNavItem("infra").mobileLabel).toBe("Servers");
  });

  it("validates item ids", () => {
    expect(isSidebarNavItemId("mail")).toBe(true);
    expect(isSidebarNavItemId("mailbox")).toBe(false);
    expect(isSidebarNavItemId(42)).toBe(false);
    expect(isSidebarNavItemId(null)).toBe(false);
    expect(() => sidebarNavItem("nope" as "mail")).toThrow(/Unknown sidebar nav item/);
  });
});

describe("normalizeSidebarNav", () => {
  it("falls back to the default layout for missing or malformed data", () => {
    for (const stored of [null, undefined, "chat", 42, {}, []]) {
      expect(ids(normalizeSidebarNav(stored))).toEqual([...SIDEBAR_NAV_ITEM_IDS]);
    }
  });

  it("keeps the stored order", () => {
    const stored = [
      { id: "settings", hidden: false },
      { id: "chat", hidden: false },
    ];

    expect(ids(normalizeSidebarNav(stored)).slice(0, 2)).toEqual(["settings", "chat"]);
  });

  it("preserves hidden flags and coerces non-boolean ones to visible", () => {
    const entries = normalizeSidebarNav([
      { id: "calendar", hidden: true },
      { id: "tasks", hidden: "yes" },
    ]);

    expect(entries.find((entry) => entry.id === "calendar")).toEqual({
      id: "calendar",
      hidden: true,
    });
    expect(entries.find((entry) => entry.id === "tasks")).toEqual({ id: "tasks", hidden: false });
  });

  it("drops unknown ids, duplicates, and junk entries", () => {
    const entries = normalizeSidebarNav([
      { id: "chat", hidden: false },
      { id: "chat", hidden: true },
      { id: "not-a-page", hidden: false },
      null,
      "chat",
      7,
    ]);

    expect(ids(entries).filter((id) => id === "chat")).toEqual(["chat"]);
    expect(ids(entries)).toHaveLength(SIDEBAR_NAV_ITEM_IDS.length);
    expect(entries[0]).toEqual({ id: "chat", hidden: false });
  });

  it("appends items the stored layout predates", () => {
    // A layout saved before "infra" existed only knows about the others.
    const stored = SIDEBAR_NAV_ITEM_IDS.filter((id) => id !== "infra").map((id) => ({
      id,
      hidden: false,
    }));

    const entries = normalizeSidebarNav(stored);

    expect(ids(entries)).toHaveLength(SIDEBAR_NAV_ITEM_IDS.length);
    expect(entries.at(-1)).toEqual({ id: "infra", hidden: false });
  });

  it("reveals every item when the stored layout hides all of them", () => {
    const stored = SIDEBAR_NAV_ITEM_IDS.map((id) => ({ id, hidden: true }));

    expect(ids(normalizeSidebarNav(stored))).toEqual([...SIDEBAR_NAV_ITEM_IDS]);
    expect(normalizeSidebarNav(stored).every((entry) => !entry.hidden)).toBe(true);
  });

  it("keeps a layout that hides all but one item", () => {
    const stored = SIDEBAR_NAV_ITEM_IDS.map((id) => ({ id, hidden: id !== "chat" }));

    expect(visibleIds(normalizeSidebarNav(stored))).toEqual(["chat"]);
  });
});

describe("isDefaultSidebarNav", () => {
  it("detects the default layout", () => {
    expect(isDefaultSidebarNav(defaultSidebarNav())).toBe(true);
    expect(isDefaultSidebarNav(normalizeSidebarNav(null))).toBe(true);
  });

  it("detects reordering and hidden items", () => {
    const hidden = defaultSidebarNav().map((entry) =>
      entry.id === "mail" ? { ...entry, hidden: true } : entry,
    );
    expect(isDefaultSidebarNav(hidden)).toBe(false);

    expect(isDefaultSidebarNav(moveSidebarNavEntry(defaultSidebarNav(), 0, 3))).toBe(false);
  });
});

describe("visibleSidebarNavItems", () => {
  it("returns visible items in the user's order", () => {
    const entries = normalizeSidebarNav([
      { id: "tasks", hidden: false },
      { id: "mail", hidden: true },
      { id: "chat", hidden: false },
    ]);

    expect(visibleSidebarNavItems(entries).map((item) => item.id)).toEqual([
      "tasks",
      "chat",
      "calendar",
      "jobs",
      "infra",
      "settings",
    ]);
  });

  it("resolves each item's route and label", () => {
    const [item] = visibleSidebarNavItems(normalizeSidebarNav([{ id: "jobs", hidden: false }]));

    expect(item).toMatchObject({ id: "jobs", href: "/dashboard/jobs", label: "Jobs" });
  });
});

describe("isSidebarNavActive", () => {
  it("matches the route and its sub-routes only", () => {
    expect(isSidebarNavActive("/dashboard/mail", "/dashboard/mail")).toBe(true);
    expect(isSidebarNavActive("/dashboard/mail", "/dashboard/mail/inbox")).toBe(true);
    expect(isSidebarNavActive("/dashboard/mail", "/dashboard/mailbox")).toBe(false);
    expect(isSidebarNavActive("/dashboard/mail", "/dashboard/chat")).toBe(false);
  });
});

describe("moveSidebarNavEntry", () => {
  it("moves an entry to a new position", () => {
    const entries = defaultSidebarNav();

    expect(ids(moveSidebarNavEntry(entries, 0, 2)).slice(0, 3)).toEqual([
      "mail",
      "calendar",
      "chat",
    ]);
    expect(ids(moveSidebarNavEntry(entries, 3, 1)).slice(0, 4)).toEqual([
      "chat",
      "tasks",
      "mail",
      "calendar",
    ]);
  });

  it("ignores no-op and out-of-range moves without mutating the input", () => {
    const entries = defaultSidebarNav();

    for (const [from, to] of [
      [0, 0],
      [-1, 2],
      [2, -1],
      [0, 99],
      [99, 0],
    ] satisfies [number, number][]) {
      const moved = moveSidebarNavEntry(entries, from, to);
      expect(ids(moved)).toEqual(ids(entries));
      expect(moved).not.toBe(entries);
    }
  });
});
