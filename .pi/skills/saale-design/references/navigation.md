# Navigation

## Dashboard Navigation

The dashboard uses a **floating console sidebar** — a `GlassPanel` (flat, bordered) with an orange-tick active state and a console footer.

### Structure (from `src/components/layout/dashboard-nav.tsx`)

```
nav.sidebar-nav (sticky top-6 h-fit w-56 shrink-0)
└─ GlassPanel (shadow-md)
   └─ GlassPanelContent p-3
      ├─ Brand row: ChevronRight (orange) + "Saale" + NotificationBell
      ├─ Separator
      ├─ Search button (ghost, w-full, ⌘K kbd) → portal dropdown (bg-popover, rounded-xl)
      └─ Nav items (space-y-0.5): the user's visible items, in the user's order (+ Admin for admins)
└─ Console footer (mt-4 border-t px-3 pt-3)
   ├─ Row: console-label "Saale 2026.10.0" (version in normal-case, same font) + theme toggle icon button
   └─ Orange tick: div.bg-primary.h-0.5.w-8.rounded-full
```

### Nav Items Come From the Registry

`src/lib/navigation/sidebar-nav.ts` is the single source of truth for ids, routes,
labels, and the default order. The desktop sidebar, the mobile bottom bar, and the
settings editor all resolve items through it:

- `SIDEBAR_NAV_ITEMS` — registry in default order (id, href, label, `mobileLabel`).
- `useSidebarNav()` (`src/components/providers/sidebar-nav-provider.tsx`) — the
  user's layout: `entries` (every item, in order, with `hidden`) and `visibleItems`.
- Icons live in the client-only `src/components/layout/sidebar-nav-icons.ts`,
  typed `Record<SidebarNavItemId, LucideIcon>` so a new id must get an icon.
- The stored layout is `AppSettings.sidebarItems` — an ordered `[{ id, hidden }]`
  array served by `/api/settings/sidebar-nav`. It is always **resolved against the
  registry** (unknown ids dropped, ids added later appended visible, an all-hidden
  layout falls back to the default), so nav items can change without a migration.
- **Never hardcode a nav list in a component.** Add the item to the registry, give
  it an icon, and it shows up in the sidebar, the bottom bar, and the settings
  editor automatically.
- Users reorder (drag, or ↑/↓ on touch) and hide items in **Settings → Appearance
  → Sidebar** (`src/app/dashboard/settings/components/sidebar-nav-editor.tsx`); at
  least one non-pinned item must stay visible. Pinned ids
  (`PINNED_SIDEBAR_NAV_IDS` — today just `settings`) can never be hidden: the
  toggle is disabled in the editor and `normalizeSidebarNav` force-reveals them,
  so hiding Settings can't lock a user out of the editor.
- Mail is the one item with extra behaviour: it is a `<button>` that expands into
  the user's accounts instead of a plain link.

### Nav Item States

```tsx
/* Console nav item — active state gets an accent fill + orange edge bar */
function navItemClass(active: boolean) {
  return cn(
    "relative flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors duration-150",
    active
      ? "bg-accent font-medium text-foreground before:absolute before:left-0 before:top-1/2 before:h-5 before:w-[3px] before:-translate-y-1/2 before:rounded-full before:bg-primary"
      : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
  );
}
```

- **Active:** `bg-accent` fill + `font-medium` + 3px orange edge bar (`before:` pseudo-element, `bg-primary`, left edge, 20px tall)
- **Inactive:** `text-muted-foreground`, hover `bg-accent/60`
- **Never** `bg-white/N` for either state

### Console Footer

The version block is the canonical console micro-label:

```tsx
<div className="border-border/60 mt-4 border-t px-3 pt-3">
  <div className="flex items-center justify-between">
    <p className="console-label">
      Saale{" "}
      <span className="text-muted-foreground/70 tracking-normal normal-case">{APP_VERSION}</span>
    </p>
    <Button variant="ghost" size="icon" className="size-7 rounded-md" onClick={/* theme toggle */} aria-label="Toggle theme">
      <Sun className="h-3.5 w-3.5 dark:hidden" />
      <Moon className="hidden h-3.5 w-3.5 dark:block" />
    </Button>
  </div>
  <div className="bg-primary mt-2 h-0.5 w-8 rounded-full" />
</div>
```

Reproduce this pattern for other "console identity" moments: `console-label` + short orange tick line.

### Sidebar Rules

- **Width:** 224px (`w-56`), `sticky top-6 h-fit` — floats, doesn't stretch
- **Icons:** `h-4 w-4`, `gap-2` to label
- **Items:** sentence case, `text-sm`
- **Search:** ghost button with `⌘K` kbd; results dropdown portals out of the panel (overflow-hidden) as a `bg-popover rounded-xl shadow-2xl` surface
- **Admin item:** only rendered for admin users, same styling, always last — it is
  not part of the user's layout and can't be reordered or hidden (the bottom bar
  appends it the same way)

## Mobile Navigation

On < 768px the sidebar is replaced by a **flat fixed bottom bar** (`src/components/layout/mobile-nav.tsx`) — not a sheet:

```tsx
<nav className="border-border bg-card fixed inset-x-0 bottom-0 z-40 border-t md:hidden">
  <div className="flex h-14 items-center px-1">
    {navItems.map((item) => (
      <Link className="flex min-w-0 flex-1 flex-col items-center gap-0.5 rounded-lg px-0.5 py-1.5">
        <Icon className={cn("h-5 w-5", isActive ? "text-primary stroke-[2.5px]" : "stroke-[1.5px]")} />
        <span className="max-w-full truncate text-[10px] font-medium">{item.label}</span>
      </Link>
    ))}
  </div>
</nav>
```

- **Flat `bg-card` + `border-t`** — no blur, no frosted glass
- **6 equal-width items** (`flex-1 min-w-0`) that fit 320px screens (8 still fit —
  verified at 320px in `e2e/mobile-content-fit.spec.ts`)
- **Route-aware:** on app pages it shows the user's visible layout, with an extra
  **Admin** item appended for admins (`useIsAdmin` from `@/hooks/use-is-admin`);
  inside `/admin/*` it mirrors `ADMIN_NAV_ITEMS` (from `@/components/admin/admin-nav`)
  plus a **Dashboard** item as the way back to the app
- **Active:** orange icon (`text-primary` + heavier stroke)
- **Labels:** 10px (9px below 360px), truncated as a safety net
- Pages must leave bottom padding for the bar (`pb-14 md:pb-0` pattern / the app shell handles it)

## Breadcrumbs

For nested views within a section:

```tsx
<Breadcrumb>
  <BreadcrumbList>
    <BreadcrumbItem><BreadcrumbLink href="/dashboard/mail">Mail</BreadcrumbLink></BreadcrumbItem>
    <BreadcrumbSeparator />
    <BreadcrumbItem><BreadcrumbPage>Inbox</BreadcrumbPage></BreadcrumbItem>
  </BreadcrumbList>
</Breadcrumb>
```

- Place above the page heading, inside the content area
- Sentence case: "Inbox" not "INBOX"

## Rules

- **Nav is a floating panel** with margin from the viewport edge (sidebar) — the only exception is the mobile bottom bar.
- **Active state = accent fill + orange edge bar.** Never a `bg-white/N` tint.
- **Icons always have labels.** No icon-only navigation on desktop.
- **Mobile uses the bottom bar.** Not a sheet, not a hamburger.
- **Max 6 nav items.** More than that needs groups or a dropdown.

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Frosted-glass mobile nav | Flat `bg-card border-t` bottom bar |
| Active item without orange bar | `before:` pseudo-element tick (3px, `bg-primary`) |
| `bg-white/N` nav fills | `bg-accent` / `hover:bg-accent/60` |
| Icon-only desktop nav | Always include text labels |
| Version text in body font | `console-label` + normal-case version, orange tick below |
