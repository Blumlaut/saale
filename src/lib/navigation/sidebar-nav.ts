/**
 * Sidebar navigation registry.
 *
 * Single source of truth for the dashboard nav — the desktop sidebar, the mobile
 * bottom bar, and the settings editor all resolve their items through this module.
 *
 * A user's own layout (display order + hidden items) is stored in
 * `AppSettings.sidebarItems` as an ordered array of `{ id, hidden }` entries and
 * is always resolved against this registry, so ids that no longer exist are
 * dropped and ids added later show up by default.
 */

/**
 * Items a user cannot hide. Settings is the only place the sidebar itself is
 * edited — hiding it would lock a user out of it.
 */
export const PINNED_SIDEBAR_NAV_IDS = ["settings"] as const satisfies readonly SidebarNavItemId[];

export function isSidebarNavPinned(id: SidebarNavItemId): boolean {
  return (PINNED_SIDEBAR_NAV_IDS as readonly string[]).includes(id);
}

/** Item ids in default display order. */
export const SIDEBAR_NAV_ITEM_IDS = [
  "chat",
  "mail",
  "calendar",
  "tasks",
  "jobs",
  "council",
  "infra",
  "settings",
] as const;

export type SidebarNavItemId = (typeof SIDEBAR_NAV_ITEM_IDS)[number];

export interface SidebarNavItem {
  id: SidebarNavItemId;
  href: string;
  label: string;
  /** Shorter label for the mobile bottom bar, where space is tight. */
  mobileLabel?: string;
  /**
   * Registered but not part of the out-of-the-box sidebar: a layout that does
   * not mention the item starts with it hidden, so the user turns it on in
   * Settings instead of turning it off. Availability is a separate question —
   * an item only reaches the nav if the route that serves the layout says so.
   */
  defaultHidden?: boolean;
}

/** One entry of a user's stored layout. */
export interface SidebarNavEntry {
  id: SidebarNavItemId;
  hidden: boolean;
}

/** Route and labels per id. Exhaustive: a new id must be described here. */
const SIDEBAR_NAV_DEFINITIONS: Record<SidebarNavItemId, Omit<SidebarNavItem, "id">> = {
  chat: { href: "/dashboard/chat", label: "Chat" },
  mail: { href: "/dashboard/mail", label: "Mail" },
  calendar: { href: "/dashboard/calendar", label: "Calendar" },
  tasks: { href: "/dashboard/tasks", label: "Tasks" },
  jobs: { href: "/dashboard/jobs", label: "Jobs" },
  // Hidden until enabled: a council costs several models at once, so it is
  // opt-in rather than a default destination.
  council: { href: "/dashboard/council", label: "Council", defaultHidden: true },
  infra: { href: "/dashboard/infra", label: "Infrastructure", mobileLabel: "Servers" },
  settings: { href: "/dashboard/settings", label: "Settings" },
};

/** Every sidebar item, in default display order. */
export const SIDEBAR_NAV_ITEMS: readonly SidebarNavItem[] = SIDEBAR_NAV_ITEM_IDS.map((id) => ({
  id,
  ...SIDEBAR_NAV_DEFINITIONS[id],
}));

const SIDEBAR_NAV_BY_ID = new Map<string, SidebarNavItem>(
  SIDEBAR_NAV_ITEMS.map((item) => [item.id, item]),
);

export function sidebarNavItem(id: SidebarNavItemId): SidebarNavItem {
  const item = SIDEBAR_NAV_BY_ID.get(id);
  if (!item) throw new Error(`Unknown sidebar nav item: ${id}`);
  return item;
}

export function isSidebarNavItemId(value: unknown): value is SidebarNavItemId {
  return typeof value === "string" && SIDEBAR_NAV_BY_ID.has(value);
}

/** Whether a pathname belongs to a nav item's route (or one of its sub-routes). */
export function isSidebarNavActive(href: string, pathname: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** Default layout: registry order, with the opt-in items hidden. */
export function defaultSidebarNav(): SidebarNavEntry[] {
  return SIDEBAR_NAV_ITEMS.map((item) => ({ id: item.id, hidden: item.defaultHidden === true }));
}

/**
 * Resolve a stored layout into a complete, ordered entry list.
 *
 * Unknown ids and duplicates are dropped, items the layout doesn't mention are
 * appended in registry order at their default visibility, and pinned items
 * (Settings) are always forced back to visible — hiding them is not a valid
 * layout.
 */
export function normalizeSidebarNav(stored: unknown): SidebarNavEntry[] {
  const entries: SidebarNavEntry[] = [];
  const seen = new Set<SidebarNavItemId>();

  if (Array.isArray(stored)) {
    for (const raw of stored) {
      if (typeof raw !== "object" || raw === null) continue;
      const { id, hidden } = raw as { id?: unknown; hidden?: unknown };
      if (!isSidebarNavItemId(id) || seen.has(id)) continue;
      seen.add(id);
      entries.push({ id, hidden: hidden === true });
    }
  }

  // An item the stored layout never mentioned starts at its registry default:
  // visible for the everyday destinations, hidden for the opt-in ones.
  for (const item of SIDEBAR_NAV_ITEMS) {
    if (!seen.has(item.id)) entries.push({ id: item.id, hidden: item.defaultHidden === true });
  }

  return entries.map((entry) =>
    isSidebarNavPinned(entry.id) ? { ...entry, hidden: false } : entry,
  );
}

/** Whether a layout matches the registry's default order and visibility. */
export function isDefaultSidebarNav(entries: readonly SidebarNavEntry[]): boolean {
  const defaults = defaultSidebarNav();
  return (
    entries.length === defaults.length &&
    entries.every(
      (entry, index) =>
        entry.id === defaults[index]?.id && entry.hidden === defaults[index]?.hidden,
    )
  );
}

/** The items a nav should render: visible only, in the user's order. */
export function visibleSidebarNavItems(entries: readonly SidebarNavEntry[]): SidebarNavItem[] {
  return entries.filter((entry) => !entry.hidden).map((entry) => sidebarNavItem(entry.id));
}

/** Move an entry from one index to another, returning a new array. */
export function moveSidebarNavEntry(
  entries: readonly SidebarNavEntry[],
  from: number,
  to: number,
): SidebarNavEntry[] {
  if (from === to || from < 0 || to < 0 || from >= entries.length || to >= entries.length) {
    return [...entries];
  }
  const next = [...entries];
  const [moved] = next.splice(from, 1);
  if (!moved) return [...entries];
  next.splice(to, 0, moved);
  return next;
}
