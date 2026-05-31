# Color System

## Palette Rules

1. **Primary colors are neutral.** The interface is built on grays, whites, and blacks.
2. **Accent colors are sparing.** Use a single accent hue for interactive states only: active nav items, primary buttons, focus rings. Not for backgrounds or large surfaces.
3. **Semantic colors only for meaning.** Red = destructive/error, green = success/completed, amber = warning/pending. Nothing else.
4. **No rainbow UI.** Charts and data visualizations use a muted, coordinated palette.
5. **All colors use `oklch()`** for perceptual uniformity across lightness levels.

## Light Mode Tokens

| Token | Value | Purpose |
|---|---|---|
| `--background` | `oklch(0.985 0.005 250)` | Page background (warm white) |
| `--foreground` | `oklch(0.145 0 0)` | Primary text |
| `--card` | `oklch(1 0 0)` | Card background (overridden by glass) |
| `--card-foreground` | `oklch(0.145 0 0)` | Card text |
| `--popover` | `oklch(1 0 0)` | Popover background |
| `--popover-foreground` | `oklch(0.145 0 0)` | Popover text |
| `--primary` | `oklch(0.205 0 0)` | Primary buttons, active states |
| `--primary-foreground` | `oklch(0.985 0 0)` | Text on primary |
| `--secondary` | `oklch(0.97 0 0)` | Secondary surfaces |
| `--secondary-foreground` | `oklch(0.205 0 0)` | Text on secondary |
| `--muted` | `oklch(0.97 0 0)` | Muted backgrounds |
| `--muted-foreground` | `oklch(0.556 0 0)` | Secondary text, labels |
| `--accent` | `oklch(0.97 0 0)` | Accent hover states |
| `--accent-foreground` | `oklch(0.205 0 0)` | Text on accent |
| `--destructive` | `oklch(0.577 0.245 27.325)` | Error, destructive actions |
| `--destructive-foreground` | `oklch(0.57 0.245 27.325)` | Text on destructive |
| `--border` | `oklch(0.922 0 0)` | Borders, dividers |
| `--input` | `oklch(0.922 0 0)` | Input backgrounds |
| `--ring` | `oklch(0.708 0 0)` | Focus rings |

## Dark Mode Tokens

| Token | Value | Purpose |
|---|---|---|
| `--background` | `oklch(0.145 0.015 250)` | Page background (deep charcoal) |
| `--foreground` | `oklch(0.985 0 0)` | Primary text |
| `--card` | `oklch(0.205 0 0)` | Card background (overridden by glass) |
| `--card-foreground` | `oklch(0.985 0 0)` | Card text |
| `--popover` | `oklch(0.205 0 0)` | Popover background |
| `--popover-foreground` | `oklch(0.985 0 0)` | Popover text |
| `--primary` | `oklch(0.922 0 0)` | Primary buttons, active states |
| `--primary-foreground` | `oklch(0.205 0 0)` | Text on primary |
| `--secondary` | `oklch(0.269 0 0)` | Secondary surfaces |
| `--secondary-foreground` | `oklch(0.985 0 0)` | Text on secondary |
| `--muted` | `oklch(0.269 0 0)` | Muted backgrounds |
| `--muted-foreground` | `oklch(0.708 0 0)` | Secondary text, labels |
| `--accent` | `oklch(0.269 0 0)` | Accent hover states |
| `--accent-foreground` | `oklch(0.985 0 0)` | Text on accent |
| `--destructive` | `oklch(0.704 0.191 22.216)` | Error, destructive actions |
| `--destructive-foreground` | `oklch(0.57 0.245 27.325)` | Text on destructive |
| `--border` | `oklch(1 0 0 / 10%)` | Borders (transparent white) |
| `--input` | `oklch(1 0 0 / 15%)` | Input backgrounds (transparent) |
| `--ring` | `oklch(0.556 0 0)` | Focus rings |

## Semantic Colors

| Meaning | Light | Dark | Usage |
|---|---|---|---|
| Success | `oklch(0.65 0.18 145)` | `oklch(0.75 0.18 145)` | Completed tasks, sent emails |
| Warning | `oklch(0.75 0.18 85)` | `oklch(0.8 0.18 85)` | Pending items, drafts |
| Error | `oklch(0.577 0.245 27.325)` | `oklch(0.704 0.191 22.216)` | Failed actions, overdue |
| Info | `oklch(0.65 0.15 230)` | `oklch(0.75 0.15 230)` | System messages, hints |

These are used as tints on glass backgrounds, never as solid fills:

```tsx
// Success badge
className="bg-green-500/10 text-green-600 dark:bg-green-400/10 dark:text-green-400"
```

## Chart Colors

For data visualizations, use a muted 5-color palette:

| Index | Value |
|---|---|
| chart-1 | `oklch(0.87 0 0)` |
| chart-2 | `oklch(0.556 0 0)` |
| chart-3 | `oklch(0.439 0 0)` |
| chart-4 | `oklch(0.371 0 0)` |
| chart-5 | `oklch(0.269 0 0)` |

These are grayscale by default. If color charts are needed, define a custom muted palette — never use default vibrant colors.

## Implementation

All colors are defined as CSS custom properties in `src/app/globals.css` and mapped through Tailwind's `@theme` block. When adding new color tokens:

1. Define the CSS variable in both `:root` and `.dark`
2. Map it in the `@theme inline` block
3. Use the Tailwind utility class (e.g., `bg-my-color`)

Never hardcode hex or rgb values in component code. Always use CSS custom properties or Tailwind utilities.

## Contrast Requirements

- **Body text:** Minimum 4.5:1 against its background (WCAG AA)
- **Large text (18px+ bold):** Minimum 3:1 (WCAG AA)
- **UI components:** Minimum 3:1 (WCAG AA)
- **Decorative elements:** No minimum (but keep subtle)

Test with oklch lightness differences of at least 0.3 between text and surface.
