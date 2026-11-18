# Color System

## Palette Rules

1. **Neutrals do the work.** The interface is built on near-grays (slightly warm in light, slightly cool-neutral in dark).
2. **One accent: orange.** `--primary` is the single colored token in the system — primary actions, active nav, focus rings, console tick. Never use it for backgrounds or large surfaces.
3. **Semantic colors only for meaning.** Red = destructive/error, green = success, amber = warning, blue = info. Used as tints (`/10` bg + colored text), never as solid fills.
4. **Flat hex values.** Tokens are plain hex in `:root` and `.dark` — no oklch, no transparency on surface tokens.
5. **Token fills only.** Row hover/selected states use `bg-accent`, `bg-muted`, `bg-secondary` — never `bg-white/N` overlays.

## Light Mode Tokens

Warm paper neutrals and an ember primary. The ember clears 4.5:1 as text on white, so `text-primary` is safe on cards; the bright `#f97316` was not.

| Token                      | Value     | Purpose                                 |
| -------------------------- | --------- | --------------------------------------- |
| `--background`             | `#f6f5f1` | Page background                         |
| `--foreground`             | `#1c1917` | Primary text                            |
| `--card`                   | `#ffffff` | Panel surfaces                          |
| `--card-foreground`        | `#1c1917` | Panel text                              |
| `--popover`                | `#ffffff` | Overlay surfaces                        |
| `--popover-foreground`     | `#1c1917` | Overlay text                            |
| `--primary`                | `#c2410c` | Ember accent (actions, active, focus)   |
| `--primary-foreground`     | `#ffffff` | Text on the accent                      |
| `--secondary`              | `#efece6` | Secondary surfaces, chips               |
| `--secondary-foreground`   | `#1c1917` | Text on secondary                       |
| `--muted`                  | `#efece6` | Muted fills, nested cards               |
| `--muted-foreground`       | `#6d675d` | Secondary text, labels                  |
| `--accent`                 | `#efece6` | Hover/selected row fills (neutral step) |
| `--accent-foreground`      | `#1c1917` | Text on accent                          |
| `--destructive`            | `#dc2626` | Error, destructive                      |
| `--destructive-foreground` | `#ffffff` | Text on destructive                     |
| `--border`                 | `#e2ded6` | 1px panel/edge borders                  |
| `--input`                  | `#cfc9be` | Input borders                           |
| `--ring`                   | `#c2410c` | Focus rings (ember)                     |

## Dark Mode Tokens

| Token                      | Value     | Purpose                                 |
| -------------------------- | --------- | --------------------------------------- |
| `--background`             | `#0b0b0c` | Page background (near-black)            |
| `--foreground`             | `#f5f5f7` | Primary text                            |
| `--card`                   | `#1a1a1c` | Panel surfaces                          |
| `--card-foreground`        | `#f5f5f7` | Panel text                              |
| `--popover`                | `#1a1a1c` | Overlay surfaces                        |
| `--popover-foreground`     | `#f5f5f7` | Overlay text                            |
| `--primary`                | `#ff7a2e` | Orange accent (brighter in dark)        |
| `--primary-foreground`     | `#0b0b0c` | Text on orange (dark)                   |
| `--secondary`              | `#202024` | Secondary surfaces, chips               |
| `--secondary-foreground`   | `#f5f5f7` | Text on secondary                       |
| `--muted`                  | `#202024` | Muted fills, nested cards               |
| `--muted-foreground`       | `#a7a7a9` | Secondary text, labels                  |
| `--accent`                 | `#202024` | Hover/selected row fills (neutral step) |
| `--accent-foreground`      | `#f5f5f7` | Text on accent                          |
| `--destructive`            | `#ef4444` | Error, destructive                      |
| `--destructive-foreground` | `#ffffff` | Text on destructive                     |
| `--border`                 | `#2a2a2e` | 1px panel/edge borders                  |
| `--input`                  | `#3a3a40` | Input borders                           |
| `--ring`                   | `#ff7a2e` | Focus rings (orange)                    |

## Surface Steps (the elevation ladder)

| Mode  | Background | Panel (`card`) | Step fill (`muted`/`accent`/`secondary`) |
| ----- | ---------- | -------------- | ---------------------------------------- |
| Light | `#f6f5f1`  | `#ffffff`      | `#efece6`                                |
| Dark  | `#0b0b0c`  | `#1a1a1c`      | `#202024`                                |

Each step is ~one notch lighter (light mode) or darker (dark mode). The border (`#e5e7e8` / `#2a2a2e`) sits at the edge of each panel.

## Semantic Colors

| Meaning | Class pattern                                                             | Usage                 |
| ------- | ------------------------------------------------------------------------- | --------------------- |
| Success | `bg-green-500/10 text-green-600 dark:bg-green-400/10 dark:text-green-400` | Completed tasks, sent |
| Warning | `bg-amber-500/10 text-amber-600 dark:bg-amber-400/10 dark:text-amber-400` | Pending, drafts       |
| Error   | `bg-red-500/10 text-red-600 dark:bg-red-400/10 dark:text-red-400`         | Failed, overdue       |
| Info    | `bg-blue-500/10 text-blue-600 dark:bg-blue-400/10 dark:text-blue-400`     | System hints          |

Always tint + colored text on a flat panel — never solid semantic fills for large areas.

## Chart Colors

| Index       | Light     | Dark      |
| ----------- | --------- | --------- |
| `--chart-1` | `#c2410c` | `#ff7a2e` |
| `--chart-2` | `#8f8a80` | `#a7a7a9` |
| `--chart-3` | `#6d675d` | `#7a7a7f` |
| `--chart-4` | `#4a443c` | `#5a5a60` |
| `--chart-5` | `#33302b` | `#3f3f45` |

Orange leads, grays follow. Never use default vibrant chart palettes.

## Implementation

All colors are CSS custom properties in `src/app/globals.css` (`:root` + `.dark`), mapped through the `@theme inline` block. When adding tokens:

1. Define in both `:root` and `.dark`
2. Map in the `@theme inline` block
3. Use the Tailwind utility (`bg-card`, `text-muted-foreground`, …)

Never hardcode hex/rgb in component code. Exception: the markdown code-block background `bg-[#1e1e2e]` (fixed dark code surface in both modes).

## Contrast Requirements

- **Body text:** minimum 4.5:1 against its surface (WCAG AA)
- **Large text (18px+ bold):** minimum 3:1
- **UI components:** minimum 3:1
- Light mode's ember primary clears 4.5:1 as text on white and on its tints; dark mode's bright orange clears it on the dark card. Pick a brand accent the same way, and draw the readable ink on fills with `--primary-foreground`
