# Glass Surfaces

## Concept

Every content panel in Saale is a "glass surface" — a translucent, blurred layer that sits above the page background. This creates depth and visual hierarchy without borders or shadows alone.

## Implementation

### Standard Glass Panel

The default panel used for most content areas:

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

### Deep Glass (Modals, Overlays)

For elements that need to stand out more:

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
/* In globals.css or a layout wrapper */
body {
  background: linear-gradient(
    180deg,
    oklch(0.985 0.005 250) 0%,
    /* warm white, barely cool */ oklch(0.96 0.008 260) 100% /* slightly cooler at bottom */
  );
}

.dark body {
  background: linear-gradient(
    180deg,
    oklch(0.145 0.015 250) 0%,
    /* deep charcoal, cool hint */ oklch(0.12 0.01 260) 100% /* near-black at bottom */
  );
}
```

The gradient should be barely noticeable. Its only purpose is giving glass panels visual context.

## Satin Finish (Optional Enhancement)

For primary panels, add a subtle gradient overlay to simulate light catching the glass edge:

```tsx
className =
  "before:absolute before:inset-0 before:bg-gradient-to-b before:from-white/20 before:to-transparent before:pointer-events-none before:rounded-2xl";
```

This adds a faint white tint at the top of the panel, fading to transparent. It should be very subtle — if it's obvious, it's too strong.

## Layering

When panels overlap (rare, but possible in modals or floating tooltips):

1. **Background:** Page gradient
2. **Layer 1:** Standard glass panels (backdrop-blur-xl)
3. **Layer 2:** Deep glass overlays (backdrop-blur-2xl)
4. **Layer 3:** Solid surfaces (tooltips, dropdowns) — use `bg-popover` with no blur

Never blur more than 2 layers deep. The third layer should be solid for performance and readability.

## Performance Notes

- `backdrop-blur` is GPU-accelerated in all modern browsers
- Avoid `backdrop-blur` on elements that change frequently (e.g., list items in a scrolling list) — use solid backgrounds instead
- Test on lower-end devices; if blur causes jank, reduce from `2xl` to `xl`
- The page background gradient should be a CSS gradient, not an image

## Common Mistakes

| Mistake                         | Fix                                                |
| ------------------------------- | -------------------------------------------------- |
| `bg-white/100` (opaque)         | Use `bg-white/60` for glass transparency           |
| No backdrop-blur                | Always pair transparency with blur                 |
| `border-gray-300` (hard border) | Use `border-white/20` for glass edge               |
| Dark mode `bg-black/50`         | Use `bg-white/5` — tinted glass, not dark box      |
| Blur on every element           | Reserve blur for panels, not list items or buttons |
| Edge-to-edge panels             | Add margin so the background shows through         |
