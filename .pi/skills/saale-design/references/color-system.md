# Color System

## Palette Rules

1. **Neutrals do the work.** The interface is built on near-grays (slightly warm in light, slightly cool-neutral in dark).
2. **One accent: orange.** `--primary` is the single colored token in the system — primary actions, active nav, focus rings, console tick. Never use it for backgrounds or large surfaces.
3. **Semantic colors only for meaning.** Red = destructive/error, green = success, amber = warning, blue = info. Used as tints (`/10` bg + colored text), never as solid fills.
4. **Flat hex values.** Tokens are plain hex in `:root` and `.dark` — no oklch, no transparency on surface tokens.
5. **Token fills only.** Row hover/selected states use `bg-accent`, `bg-muted`, `bg-secondary` — never `bg-white/N` overlays.

## Light Mode Tokens

| Token | Value | Purpose |
|-------|-------|---------|
| `--background` | `#f7f8fa` | Page background |
| `--foreground` | `#111827` | Primary text |
| `--card` | `#ffffff` | Panel surfaces |
| `--card-foreground` | `#111827` | Panel text |
| `--popover` | `#ffffff` | Overlay surfaces |
| `--popover-foreground` | `#111827` | Overlay text |
| `--primary` | `#f97316` | Orange accent (actions, active, focus) |
| `--primary-foreground` | `#111827` | Text on orange |
| `--secondary` | `#f1f2f4` | Secondary surfaces, chips |
| `--secondary-foreground` | `#111827` | Text on secondary |
| `--muted` | `#f1f2f4` | Muted fills, nested cards |
| `--muted-foreground` | `#6b7280` | Secondary text, labels |
| `--accent` | `#f1f2f4` | Hover/selected row fills (neutral step) |
| `--accent-foreground` | `#111827` | Text on accent |
| `--destructive` | `#ef4444` | Error, destructive |
| `--destructive-foreground` | `#ffffff` | Text on destructive |
| `--border` | `#e5e7e8` | 1px panel/edge borders |
| `--input` | `#d1d5db` | Input borders |
| `--ring` | `#f97316` | Focus rings (orange) |

## Dark Mode Tokens

| Token | Value | Purpose |
|-------|-------|---------|
| `--background` | `#0b0b0c` | Page background (near-black) |
| `--foreground` | `#f5f5f7` | Primary text |
| `--card` | `#1a1a1c` | Panel surfaces |
| `--card-foreground` | `#f5f5f7` | Panel text |
| `--popover` | `#1a1a1c` | Overlay surfaces |
| `--popover-foreground` | `#f5f5f7` | Overlay text |
| `--primary` | `#ff7a2e` | Orange accent (brighter in dark) |
| `--primary-foreground` | `#0b0b0c` | Text on orange (dark) |
| `--secondary` | `#202024` | Secondary surfaces, chips |
| `--secondary-foreground` | `#f5f5f7` | Text on secondary |
| `--muted` | `#202024` | Muted fills, nested cards |
| `--muted-foreground` | `#a7a7a9` | Secondary text, labels |
| `--accent` | `#202024` | Hover/selected row fills (neutral step) |
| `--accent-foreground` | `#f5f5f7` | Text on accent |
| `--destructive` | `#ef4444` | Error, destructive |
| `--destructive-foreground` | `#ffffff` | Text on destructive |
| `--border` | `#2a2a2e` | 1px panel/edge borders |
| `--input` | `#3a3a40` | Input borders |
| `--ring` | `#ff7a2e` | Focus rings (orange) |

## Surface Steps (the elevation ladder)

| Mode | Background | Panel (`card`) | Step fill (`muted`/`accent`/`secondary`) |
|------|-----------|----------------|------------------------------------------|
| Light | `#f7f8fa` | `#ffffff` | `#f1f2f4` |
| Dark | `#0b0b0c` | `#1a1a1c` | `#202024` |

Each step is ~one notch lighter (light mode) or darker (dark mode). The border (`#e5e7e8` / `#2a2a2e`) sits at the edge of each panel.

## Semantic Colors

| Meaning | Class pattern | Usage |
|---------|---------------|-------|
| Success | `bg-green-500/10 text-green-600 dark:bg-green-400/10 dark:text-green-400` | Completed tasks, sent |
| Warning | `bg-amber-500/10 text-amber-600 dark:bg-amber-400/10 dark:text-amber-400` | Pending, drafts |
| Error | `bg-red-500/10 text-red-600 dark:bg-red-400/10 dark:text-red-400` | Failed, overdue |
| Info | `bg-blue-500/10 text-blue-600 dark:bg-blue-400/10 dark:text-blue-400` | System hints |

Always tint + colored text on a flat panel — never solid semantic fills for large areas.

## Chart Colors

| Index | Light | Dark |
|-------|-------|------|
| `--chart-1` | `#f97316` | `#ff7a2e` |
| `--chart-2` | `#9ca3af` | `#a7a7a9` |
| `--chart-3` | `#6b7280` | `#7a7a7f` |
| `--chart-4` | `#4b5563` | `#5a5a60` |
| `--chart-5` | `#374151` | `#3f3f45` |

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
- Orange on near-black passes AA for text; orange text on white does NOT — use `--primary-foreground` (dark text) on orange fills
