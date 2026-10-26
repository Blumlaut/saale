# Layout

## Dashboard Shell

The dashboard is a **fixed-height app shell** — `h-dvh overflow-hidden` on the root. The body/viewport **never scrolls**; all scrolling is internal to panels. Pages are built from the shared `Page` components (`src/components/layout/page.tsx`): `Page`, `PageActions`, `PageAction`, `PageStatus`, `PageSection`, `PageScroll`, `PageTabStrip`.

The flex containment chain: `h-full` (page) → `flex flex-col` → optional pinned action row (`shrink-0`) → content (`flex-1 min-h-0 overflow-hidden`) → scroll area (`flex-1 overflow-y-auto`) → footer (`shrink-0`).

### No page titles — the content owns the toolbar

Pages never render a page title (no title text, no subtitle, no title+action rows) — the nav already names the page and the row is wasted space. Instead:

- **List/content pages:** a single full-height `GlassPanel` (`flex h-full flex-col overflow-hidden border-0`) in a `<Page className="gap-0">`. Its **first row is `<PageActions>`**: actions on the right as `<PageAction>` (icon on a phone, label at `md:`), functional context (date range, account switcher, search) on the left — never a bare page name. The body scrolls internally (`flex-1 min-h-0 overflow-y-auto`).
- **Form and settings pages:** the same single panel and the same `<PageActions>` row, with the groups of settings stacked inside it as `<PageSection>`s. Save is a `<PageAction label="Save">`, feedback is `<PageStatus>`.
- **Tab pages:** the `PageTabStrip` row IS the toolbar; actions go to its right.
- **Two-panel pages** (jobs, council, mail): the action goes in the first panel's `GlassPanelHeader` `action` slot.

### Structure

```
┌─────────────────────────────────────────────┐
│  Page Background (solid token)                 │
│  ┌─────────────────────────────────────┐    │
│  │  Floating Nav / Sidebar             │    │  ← margin from edge
│  │                                     │    │
│  │  ┌─────────────────────────────┐    │    │
│  │  │  Content Panel 1            │    │    │  ← gap-6 between
│  │  │                             │    │    │
│  │  └─────────────────────────────┘    │    │
│  │  ┌─────────────────────────────┐    │    │
│  │  │  Content Panel 2            │    │    │
│  │  │                             │    │    │
│  │  └─────────────────────────────┘    │    │
│  └─────────────────────────────────────┘    │
└─────────────────────────────────────────────┘
```

### Page Margins

| Breakpoint        | Margin | Classes |
| ----------------- | ------ | ------- |
| Desktop (≥1024px) | 24px   | `p-6`   |
| Tablet (≥768px)   | 20px   | `p-5`   |
| Mobile (<768px)   | 16px   | `p-4`   |

```tsx
// Dashboard layout wrapper
<main className="mx-auto max-w-[1600px] p-4 md:p-5 lg:p-6">{/* floating panels */}</main>
```

### Full-Bleed Views (the exception)

A view that _is_ the window — currently only **chat** — opts out of the page
margin **on phones**: its layout root carries `.full-bleed` and the shell drops
the gutter (see `globals.css`). The panels inside lose their radius
(`rounded-none md:rounded-2xl`) so the surface runs edge to edge instead of
sitting in a window of dead space, and the composer ends exactly at the bottom
nav instead of leaving a band above it.

**Desktop keeps the console gutter and the rounded panels.** A wide window has
room for the floating nav _and_ the view, and a rounded card that touches the
window edge shows the page background in its corner nooks — so the view is a
card on desktop and a viewport on a phone. The nav never bleeds either way; on
phones the bottom nav keeps its clearance (`3.5rem`).

Full-bleed is for phone viewport views (streams, conversations, canvases) —
list, form and settings pages keep the standard page margins everywhere.

`e2e/chat-full-bleed.spec.ts` asserts both states — phones flush and square,
desktop inset with rounded panels — so a regression fails CI.

## Panel Layout

### Single Column (Default)

Most views are a single column of stacked panels:

```tsx
<div className="flex flex-col gap-6">
  <GlassPanel>...</GlassPanel>
  <GlassPanel>...</GlassPanel>
</div>
```

### Two Columns

Only when it adds clarity (comparison, master-detail):

```tsx
<div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
  <GlassPanel>...</GlassPanel>
  <GlassPanel>...</GlassPanel>
</div>
```

### Master-Detail

A list on the left, detail on the right:

```tsx
<div className="grid grid-cols-1 gap-6 lg:grid-cols-[380px_1fr]">
  <GlassPanel>{/* list of items */}</GlassPanel>
  <GlassPanel>{/* detail view */}</GlassPanel>
</div>
```

## Max Widths

Content panels should never stretch full width on large screens:

| Content Type         | Max Width         | Classes          |
| -------------------- | ----------------- | ---------------- |
| Reading (mail, chat) | 768px             | `max-w-3xl`      |
| Forms, settings      | 640px             | `max-w-2xl`      |
| Dashboard overview   | 1280px            | `max-w-[1280px]` |
| Full-width tables    | 100% of container | (no max-width)   |

## Spacing System

All spacing follows the 4px rhythm (Tailwind default scale):

| Context               | Spacing | Classes |
| --------------------- | ------- | ------- |
| Between panels        | 24px    | `gap-6` |
| Inside panels         | 24px    | `p-6`   |
| Inside dense lists    | 16px    | `p-4`   |
| Between form fields   | 16px    | `gap-4` |
| Between related items | 8px     | `gap-2` |
| Icon to text          | 8px     | `gap-2` |
| Tight grouping        | 4px     | `gap-1` |

## Responsive Behavior

| Element       | Desktop (≥768px) | Mobile (<768px)   |
| ------------- | ---------------- | ----------------- |
| Panel layout  | 2-col if needed  | Single column     |
| Navigation    | Floating sidebar | Flat bottom bar   |
| Page margins  | 20–24px          | 16px + bottom nav |
| Panel padding | 24px             | 16px              |
| Font sizes    | Scaled (clamp)   | Scaled (clamp)    |

### Responsive Pattern

```tsx
<div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
  {/* stacks on mobile/tablet, side-by-side on desktop */}
</div>
```

## Alignment

- **Left-aligned** text everywhere (no centered body text)
- **Centered** only for: empty states, auth pages, error pages
- **Right-aligned** only for: numerical values in tables, action buttons in form footers

## Common Mistakes

| Mistake                       | Fix                                                                       |
| ----------------------------- | ------------------------------------------------------------------------- |
| `h-dvh`/`h-screen` in a page  | The shell owns viewport height — use `h-full`                             |
| Page title / title+action row | Content owns the toolbar — no title text at all                           |
| Page-level `overflow-y-auto`  | Use `<PageScroll>` — the only scroll region                               |
| Edge-to-edge panels           | Add page margins (`p-6`) — unless the view is full-bleed on phones (chat) |
| 3+ column grid                | Reduce to 1 or 2 columns                                                  |
| `w-full` on content panels    | Use `max-w-3xl` or similar                                                |
| Inconsistent gaps             | Use `gap-6` between panels always                                         |
| Centered body text            | Left-align everything                                                     |
| No responsive breakpoint      | Add `lg:` prefix for desktop-only layouts                                 |
