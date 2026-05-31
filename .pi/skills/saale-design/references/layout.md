# Layout

## Dashboard Shell

The dashboard uses a **floating panel layout**, not a sidebar + content split that stretches edge-to-edge.

### Structure

```
┌─────────────────────────────────────────────┐
│  Page Background (gradient)                 │
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

| Breakpoint | Margin | Classes |
|---|---|---|
| Desktop (≥1024px) | 24px | `p-6` |
| Tablet (≥768px) | 20px | `p-5` |
| Mobile (<768px) | 16px | `p-4` |

```tsx
// Dashboard layout wrapper
<main className="p-4 md:p-5 lg:p-6 max-w-[1600px] mx-auto">
  {/* floating panels */}
</main>
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
<div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
  <GlassPanel>...</GlassPanel>
  <GlassPanel>...</GlassPanel>
</div>
```

### Master-Detail

A list on the left, detail on the right:

```tsx
<div className="grid grid-cols-1 lg:grid-cols-[380px_1fr] gap-6">
  <GlassPanel>
    {/* list of items */}
  </GlassPanel>
  <GlassPanel>
    {/* detail view */}
  </GlassPanel>
</div>
```

## Max Widths

Content panels should never stretch full width on large screens:

| Content Type | Max Width | Classes |
|---|---|---|
| Reading (mail, chat) | 768px | `max-w-3xl` |
| Forms, settings | 640px | `max-w-2xl` |
| Dashboard overview | 1280px | `max-w-[1280px]` |
| Full-width tables | 100% of container | (no max-width) |

## Spacing System

All spacing follows the 4px rhythm (Tailwind default scale):

| Context | Spacing | Classes |
|---|---|---|
| Between panels | 24px | `gap-6` |
| Inside panels | 24px | `p-6` |
| Inside dense lists | 16px | `p-4` |
| Between form fields | 16px | `gap-4` |
| Between related items | 8px | `gap-2` |
| Icon to text | 8px | `gap-2` |
| Tight grouping | 4px | `gap-1` |

## Responsive Behavior

| Element | Desktop | Tablet | Mobile |
|---|---|---|---|
| Panel layout | 2-col if needed | Single column | Single column |
| Sidebar | Visible | Collapsed / overlay | Overlay |
| Page margins | 24px | 20px | 16px |
| Panel padding | 24px | 20px | 16px |
| Font sizes | Standard | Standard | Standard (no scaling) |

### Responsive Pattern

```tsx
<div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
  {/* stacks on mobile/tablet, side-by-side on desktop */}
</div>
```

## Alignment

- **Left-aligned** text everywhere (no centered body text)
- **Centered** only for: empty states, auth pages, error pages
- **Right-aligned** only for: numerical values in tables, action buttons in form footers

## Common Mistakes

| Mistake | Fix |
|---|---|
| Edge-to-edge panels | Add page margins (`p-6`) |
| 3+ column grid | Reduce to 1 or 2 columns |
| `w-full` on content panels | Use `max-w-3xl` or similar |
| Inconsistent gaps | Use `gap-6` between panels always |
| Centered body text | Left-align everything |
| No responsive breakpoint | Add `lg:` prefix for desktop-only layouts |
