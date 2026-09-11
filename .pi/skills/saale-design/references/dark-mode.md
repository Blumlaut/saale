# Dark Mode

## Rules

1. **Every component supports dark mode.** No exceptions.
2. **System preference is the default.** `next-themes` with `attribute="class"`, `defaultTheme="system"`.
3. **User choice overrides system.** The toggle (sidebar footer: sun/moon button) stores the choice in `localStorage` via next-themes.
4. **No flash of wrong theme.** Theme applied before first render; `suppressHydrationWarning` on `<html>`.
5. **Both modes are equally polished.** Dark mode is not an afterthought — the palette is designed for both (near-black `#0b0b0c` background, `#1a1a1c` panels, brighter orange `#ff7a2e`).

## Flat Surfaces in Dark Mode

There is no glass in either mode. Dark mode panels are **solid flat surfaces**:

```tsx
// Panel — just use the tokens, no dark: overrides needed
className = "bg-card text-card-foreground border border-border";

// Row hover / selected — token fills, both modes
className = "hover:bg-accent/60";   // hover
className = "bg-accent";            // selected

// Overlay (dialog/sheet/popover) — liquid-glass utility (flat, bordered, elevated)
className = "liquid-glass";
```

Never write `dark:bg-white/5` or `dark:bg-black/40` — the tokens already flip per mode.

## CSS Custom Properties

All colors are flat hex custom properties in `globals.css`:

```css
:root {
  --background: #f7f8fa;
  --foreground: #111827;
  --primary: #f97316;
  /* ... */
}

.dark {
  --background: #0b0b0c;
  --foreground: #f5f5f7;
  --primary: #ff7a2e;
  /* ... */
}
```

Mapped to Tailwind via the `@theme inline` block. Use utilities, never hardcoded values:

```tsx
// Correct
className = "bg-background text-foreground border-border";

// Wrong
className = "bg-white text-black border-gray-200";
```

Dark-mode-specific overrides (`dark:`) are needed only for things tokens don't cover, e.g. semantic tints:

```tsx
className = "bg-green-500/10 text-green-600 dark:bg-green-400/10 dark:text-green-400";
```

## Contrast Verification

| Element | Light | Dark |
|---------|-------|------|
| Primary text on background | ~15:1 | ~17:1 |
| Secondary text on background | ~4.8:1 | ~7:1 |
| Border on background | visible 1px edge | visible 1px edge |
| Orange on card (text) | use `#c2570c`-equivalent tints, not raw orange on white | passes |

Test every component in both modes. If it reads well in light but not dark, adjust the token — don't add component-specific overrides.

## Transition Between Modes

Globals apply a 0.2s color crossfade on all elements (background-color, border-color, color) with intentional animations excluded. Do not add per-component theme transitions.

## Testing Checklist

- [ ] Every component tested in both light and dark mode
- [ ] Panels are opaque `bg-card` in both modes (no transparency, no blur)
- [ ] Row hover/selected fills use token fills, visible in both modes
- [ ] Orange accent visible and AA in both modes (dark text on orange in light mode)
- [ ] Text contrast meets WCAG AA in both modes
- [ ] Borders and dividers visible in both modes
- [ ] No hardcoded hex/rgb in components
- [ ] No `dark:bg-white/N` residue (glass idiom)
- [ ] Theme toggle (sidebar footer) works and persists
- [ ] No flash of wrong theme on page load
