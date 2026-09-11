# Console Surfaces

> Filename kept from the old glass system (`glass-surfaces.md`). The surface language is now **flat console** — no glass, no blur.

## Concept

Every content panel in Saale is a **flat, opaque, border-defined surface** on a solid background. Depth comes from:

1. The 1px `border-border` edge
2. The one-step surface elevation (`--background` → `--card`)
3. Elevation shadow on **overlays only** (dialogs, sheets, popovers)

Never use `backdrop-blur`, `bg-white/N` fills, or gradients on surfaces. If a surface looks translucent, it is wrong.

## CSS Utilities (in globals.css)

Class names are legacy (they came from the glass system) but render as flat console surfaces:

| Class | Use | Appearance |
|-------|-----|-----------|
| `glass-panel` | Main content panels | Solid `bg-card`, 1px `border-border`, `rounded-2xl` |
| `glass-panel-subtle` | Inline bars, toolbars, subtle sections | Solid `bg-muted/50`, 1px border, `rounded-xl` |
| `glass-panel-deep` | Elevated content regions | Solid `bg-card`, 1px border, `rounded-3xl` |
| `liquid-glass` | Overlay surfaces (sheets, modals, popovers) | Solid `bg-popover`, 1px border, elevation shadow |
| `liquid-glass-inner` | Nested content cards within panels | Solid `bg-muted`, 1px border |
| `liquid-glass-pill` | Secondary chips, badges, icon containers | Solid `bg-secondary`, 1px border, hover `bg-muted` |
| `liquid-glass-accent` | Primary action surfaces | Solid `bg-primary`, orange text-foreground |
| `liquid-glass-destructive` | Delete, remove, destructive actions | 12% red tint, 35% red border, red text |

### Usage

```tsx
// Sheet / dialog — liquid-glass is baked in, do NOT add it manually
<SheetContent className="flex w-full flex-col p-0 sm:w-[440px]">
  {/* content */}
</SheetContent>

// Nested content card inside a panel
<div className="liquid-glass-inner rounded-xl px-4 py-3.5">
  <p className="text-xs text-muted-foreground">Label</p>
  <p className="text-sm">Value</p>
</div>

// Pill chip (secondary)
<Button className="liquid-glass-pill h-9 text-xs font-medium" variant="ghost">
  Action
</Button>

// Accent (primary) button
<Button className="liquid-glass-accent h-9 text-xs font-medium">
  Save Changes
</Button>
```

## Page Background

Solid color, never a gradient:

- Light: `#f7f8fa` (`--background`)
- Dark: `#0b0b0c` (`--background`)

The background is one step darker (light mode) or lighter (dark mode) than nothing else — panels sit on it and the border does the separating.

## Surface Elevation Ladder

| Level | Surface | Where |
|-------|---------|-------|
| 0 | `bg-background` | Page background |
| 1 | `bg-card` | Panels, rows resting surface |
| 2 | `bg-muted` / `bg-secondary` | Nested cards, hover fills, selected fills |
| 3 | `bg-popover` + shadow | Overlays only (dialog, sheet, popover, dropdown, select) |

Hover/selected row states: `hover:bg-accent/60` and `bg-accent` / `bg-accent/70` (accent = the neutral step fill in both modes). Never `bg-white/N`.

## Layering

When surfaces overlap:

1. **Background:** solid `--background`
2. **Layer 1:** `glass-panel` content panels
3. **Layer 2:** `liquid-glass` overlays (solid `bg-popover` + elevation shadow)
4. **Layer 3:** further popovers/dropdowns — same solid surface, higher `z-`

Every layer is opaque. No blurring, ever.

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| `backdrop-blur-*` on a panel | Remove it — console surfaces are opaque |
| `bg-white/10`, `bg-white/20` fills | Token fills: `bg-accent/60`, `bg-muted`, `bg-secondary` |
| Gradient background (body or panel) | Solid `bg-background` / `bg-card` |
| `border-0` on an overlay | Keep the 1px `border-border` — it defines the surface |
| Panel shadow for depth (`shadow-sm` on panels) | Borders carry depth; shadows are for overlays only |
| Orange for non-primary things | Orange is `--primary`: actions, active, focus. Nothing else |
| Translucent-looking code blocks / sticky headers | Opaque fills (e.g. `bg-[#1e1e2e]` code, `bg-card` sticky `th`) |
