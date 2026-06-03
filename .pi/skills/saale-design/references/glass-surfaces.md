# Glass Surfaces

## Concept

Every content panel in Saale is a "glass surface" — a translucent, blurred layer that sits above the page background. This creates depth and visual hierarchy without borders or shadows alone.

## Liquid Glass (Primary Style)

Saale uses an **Apple-inspired liquid glass** aesthetic for overlays, sheets, and modals. This goes beyond simple frosted glass by adding:

- **Saturated backdrop blur** — `saturate(180%)` enriches colors behind the glass
- **Specular inner glow** — `inset 0 1px 0 rgba(255,255,255,0.5)` simulates light catching the glass edge
- **Gradient fill** — subtle diagonal gradient for depth, not flat transparency
- **Pill-shaped interactive elements** — `rounded-full` on all buttons, badges, toggles

### CSS Utilities (in globals.css)

| Class | Use | Appearance |
|-------|-----|-----------|
| `liquid-glass` | Main surfaces (sheets, modals, overlays) | Deep frosted glass with specular edge glow |
| `liquid-glass-inner` | Nested content cards within glass surfaces | Softer, lighter glass for grouping content |
| `liquid-glass-pill` | Secondary buttons, badges, icon containers | Translucent pill with hover response |
| `liquid-glass-accent` | Primary action buttons | Blue-tinted glass with glow shadow |
| `liquid-glass-destructive` | Delete, remove, destructive actions | Red-tinted glass, text-only (no red bg) |

### Usage

```tsx
// Sheet with liquid glass
<SheetContent className="liquid-glass flex w-[440px] flex-col overflow-hidden border-0 bg-transparent p-0 shadow-2xl dark:w-[460px] sm:max-w-none">
  {/* content */}
</SheetContent>

// Inner content card
<div className="liquid-glass-inner rounded-2xl px-4 py-3.5">
  <p className="text-xs text-muted-foreground">Label</p>
  <p className="text-sm">Value</p>
</div>

// Pill button
<Button className="liquid-glass-pill h-9 rounded-full text-xs font-medium" variant="ghost">
  Action
</Button>

// Accent (primary) button
<Button className="liquid-glass-accent h-9 rounded-full text-xs font-medium">
  Save Changes
</Button>

// Destructive button
<Button className="liquid-glass-destructive h-9 rounded-full text-xs font-medium" variant="ghost">
  Delete
</Button>
```

### Light vs Dark Mode

The liquid glass utilities handle both modes automatically:

- **Light mode:** White-dominant gradients, bright specular highlights, soft shadows
- **Dark mode:** Dark translucent gradients, subtle white edge glow, deeper shadows

Always test both modes — the specular highlight is key to the "glass" feel in both.

## Standard Glass Panel

The default panel used for most dashboard content areas:

```tsx
className =
  "bg-white/60 dark:bg-white/5 backdrop-blur-xl border border-white/20 dark:border-white/10 shadow-lg rounded-2xl";
```

Breakdown:

- `bg-white/60` — Semi-transparent white fill (light mode)
- `dark:bg-white/5` — Barely-there white tint (dark mode, like tinted glass)
- `backdrop-blur-xl` — 12px blur of whatever is behind
- `border border-white/20` — Subtle edge definition (light)
- `dark:border-white/10` — Even subtler edge (dark)
- `shadow-lg` — Soft floating shadow
- `rounded-2xl` — 16px corners

### Deep Glass (Fallback for Modals)

For elements that need to stand out more (when not using liquid glass):

```tsx
className =
  "bg-white/80 dark:bg-black/40 backdrop-blur-2xl border border-white/30 dark:border-white/10 shadow-xl rounded-3xl";
```

### Subtle Glass (Inline Elements, Toolbars)

For elements inside panels that need a slight separation:

```tsx
className =
  "bg-white/30 dark:bg-white/5 backdrop-blur-lg border border-white/10 dark:border-white/5 rounded-xl";
```

## Page Background

The page background is NOT a flat color. It uses a soft gradient so glass surfaces have something to react against:

```css
/* In globals.css */
body {
  background: linear-gradient(
    180deg,
    oklch(0.97 0.008 255) 0%,
    oklch(0.95 0.01 260) 50%,
    oklch(0.94 0.012 265) 100%
  );
}

.dark body {
  background: linear-gradient(
    180deg,
    oklch(0.145 0.015 255) 0%,
    oklch(0.13 0.012 260) 50%,
    oklch(0.12 0.01 265) 100%
  );
}
```

The gradient should be barely noticeable. Its only purpose is giving glass panels visual context.

## Layering

When panels overlap (modals, sheets, floating tooltips):

1. **Background:** Page gradient
2. **Layer 1:** Standard glass panels (backdrop-blur-xl)
3. **Layer 2:** Liquid glass overlays (saturate + backdrop-blur-2xl)
4. **Layer 3:** Solid surfaces (tooltips, dropdowns) — use `bg-popover` with no blur

Never blur more than 2 layers deep. The third layer should be solid for performance and readability.

## Performance Notes

- `backdrop-filter` is GPU-accelerated in all modern browsers
- Avoid `backdrop-filter` on elements that change frequently (e.g., list items in a scrolling list) — use solid backgrounds instead
- Test on lower-end devices; if blur causes jank, reduce from `2xl` to `xl`
- The page background gradient should be a CSS gradient, not an image
- `saturate()` adds minimal overhead — keep it at 140-180% for best visual/performance balance

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| `bg-white/100` (opaque) | Use `bg-white/60` for glass transparency |
| No backdrop-blur | Always pair transparency with blur |
| `border-gray-300` (hard border) | Use `border-white/20` for glass edge |
| Dark mode `bg-black/50` | Use `bg-white/5` — tinted glass, not dark box |
| Blur on every element | Reserve blur for panels, not list items or buttons |
| Edge-to-edge panels | Add margin so the background shows through |
| Square buttons in liquid glass | Use `rounded-full` for pill shape |
| Flat liquid glass (no gradient) | Use the CSS utility classes — they include gradient fills |
