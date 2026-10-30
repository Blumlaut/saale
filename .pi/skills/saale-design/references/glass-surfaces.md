# Console Surfaces

> Filename kept from the old glass system (`glass-surfaces.md`). The surface language is now **flat console** — no glass, no blur.

## Concept

Every content panel in Saale is a **flat, opaque, border-defined surface** on a solid background. Depth comes from:

1. The 1px `border-border` edge
2. The one-step surface elevation (`--background` → `--card`)
3. Elevation shadow on **overlays only** (dialogs, sheets, popovers)

Never use `backdrop-blur`, `bg-white/N` fills, or gradients on surfaces. If a surface looks translucent, it is wrong.

## Surface Utilities

Surfaces are token utilities, not classes of their own:

| Layer | Use | Classes |
|-------|-----|---------|
| Panel | Main content panels | `glass-panel` (from `GlassPanel`): `bg-card border border-border rounded-2xl` |
| Subtle bar | Inline bars, toolbars | `bg-muted/50 border border-border rounded-xl` |
| Overlay | Sheets, modals, popovers, menus | `bg-popover border border-border shadow-2xl`, baked into the primitive |
| Nested card | A card inside a panel | `bg-muted border border-border rounded-xl` |
| Action | Buttons | `<Button>` variants — `default` (primary), `secondary`, `destructive`, `ghost`, `outline` |

A surface never gets a hand-written fill: no `bg-primary` or `bg-destructive/10` on a button, and no pill radius — buttons are `rounded-lg`.

### Usage

```tsx
// Sheet / dialog — the surface comes from the primitive
<SheetContent className="flex w-full flex-col p-0 sm:w-[440px]">
  {/* content */}
</SheetContent>

// Nested content card inside a panel
<div className="bg-muted border-border rounded-xl border px-4 py-3.5">
  <p className="text-xs text-muted-foreground">Label</p>
  <p className="text-sm">Value</p>
</div>

// Secondary action
<Button variant="secondary">Action</Button>

// Primary action
<Button>Save Changes</Button>
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
3. **Layer 2:** overlays (solid `bg-popover`, 1px border, elevation shadow)
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
