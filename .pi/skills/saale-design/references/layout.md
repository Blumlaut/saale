# Layout

## Dashboard Shell

The dashboard is a **fixed-height app shell** — `h-dvh overflow-hidden` on the root. The body/viewport **never scrolls**; all scrolling is internal to panels. Pages are built from the shared `Page` components (`src/components/layout/page.tsx`): `Page`, `PageToolbar`, `PageScroll`, `PageTabStrip`. Pages have **no title/subtitle header** — a two-line title+description row is wasted space. At most a compact one-line header (title left, actions right, no subtitle) via `PageToolbar`; pages without actions start straight at their content.

The flex containment chain: `h-full` (page) → `flex flex-col` → optional action row (`shrink-0`) → content (`flex-1 min-h-0 overflow-hidden`) → scroll area (`flex-1 overflow-y-auto`) → footer (`shrink-0`).

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

| Element       | Desktop (≥768px) | Mobile (<768px)      |
| ------------- | ---------------- | -------------------- |
| Panel layout  | 2-col if needed  | Single column        |
| Navigation    | Floating sidebar | Flat bottom bar      |
| Page margins  | 20–24px          | 16px + bottom nav    |
| Panel padding | 24px             | 16px                 |
| Font sizes    | Scaled (clamp)   | Scaled (clamp)       |

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

| Mistake                    | Fix                                       |
| -------------------------- | ----------------------------------------- |
| `h-dvh`/`h-screen` in a page | The shell owns viewport height — use `h-full` |
| Page-level `overflow-y-auto` | Use `<PageScroll>` — the only scroll region |
| Edge-to-edge panels        | Add page margins (`p-6`)                  |
| 3+ column grid             | Reduce to 1 or 2 columns                  |
| `w-full` on content panels | Use `max-w-3xl` or similar                |
| Inconsistent gaps          | Use `gap-6` between panels always         |
| Centered body text         | Left-align everything                     |
| No responsive breakpoint   | Add `lg:` prefix for desktop-only layouts |
