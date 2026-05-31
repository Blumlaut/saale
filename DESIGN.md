# Saale — Design Principles

> Every UI change must conform to this document. When in doubt, follow these rules over personal preference.

## Philosophy

Saale is a productivity hub — email, chat, tasks in one place. The interface should feel **calm, spacious, and instantly readable**. A user should understand their situation at a glance without hunting for information.

We are **not** building:
- A gaming dashboard (no neon, no aggressive gradients, no "cyber" aesthetics)
- A developer tool (no monospace UI text, no terminal-inspired styling, no raw data dumps)
- A dense enterprise app (no cramped tables, no information overload)

We **are** building a friendly, modern workspace that gets out of the way.

---

## Visual Language: Liquid Glass

The core visual metaphor is **liquid glass** — surfaces that feel translucent, layered, and softly blurred, like looking through frosted glass. This creates depth without visual noise.

### Glass Surfaces

All content panels, cards, and floating windows use a glass effect:

- **Background:** Semi-transparent fill over the page background
- **Backdrop blur:** `backdrop-blur-xl` (12px) minimum, `backdrop-blur-2xl` (24px) for primary surfaces
- **Border:** Subtle 1px border using `ring-foreground/5` or `border-border/50` — just enough to define edges
- **Shadow:** Soft, large-spread shadows (`shadow-lg` or custom) that suggest floating, not dropping
- **Satin finish:** A subtle gradient overlay (white-tinted at top, transparent at bottom) to simulate light catching the glass edge

**Implementation pattern:**

```tsx
// Glass panel — use this class pattern or the GlassPanel component
className="bg-white/60 dark:bg-white/5 backdrop-blur-xl border border-white/20 dark:border-white/10 shadow-lg"
```

For deeper glass (modals, overlays):

```tsx
className="bg-white/80 dark:bg-black/40 backdrop-blur-2xl border border-white/30 dark:border-white/10 shadow-xl"
```

### Page Background

The page background is **not** a flat color. It uses a soft gradient or subtle mesh to give the glass surfaces something to react against:

- **Light mode:** Warm white to soft cool gray gradient, very subtle (`oklch` tones, low chroma)
- **Dark mode:** Deep charcoal to near-black, with a hint of cool blue (`oklch(0.145 0.015 250)` range)
- The gradient should be barely noticeable — it exists so glass panels have visual context

### Floating Windows

Content areas feel like floating panes, not flat divs:

- **Rounded corners:** `rounded-2xl` (16px) for panels, `rounded-3xl` (24px) for modals/overlays
- **Spacing from edges:** Panels have margin from viewport edges (they don't stretch edge-to-edge)
- **Vertical rhythm:** Panels stack with `gap-6` (24px) minimum, creating breathing room
- **No hard edges against viewport:** The page background shows through around panels

---

## Color System

### Palette Rules

- **Primary colors are neutral.** The interface is built on grays, whites, and blacks with oklch color space for perceptual uniformity.
- **Accent colors are sparing.** Use a single accent hue (to be defined) for interactive states only: active nav items, primary buttons, focus rings. Not for backgrounds or large surfaces.
- **Semantic colors only for meaning.** Red = destructive/error, green = success/completed, amber = warning/pending. Nothing else.
- **No rainbow UI.** Charts and data visualizations use a muted, coordinated palette — never default vibrant colors.

### Light Mode

| Token | Value | Purpose |
|---|---|---|
| Background | `oklch(0.985 0.005 250)` | Page background (warm white, barely cool) |
| Glass surface | `bg-white/60` | Panel backgrounds with blur |
| Glass border | `border-white/20` | Panel edges |
| Text primary | `oklch(0.145 0 0)` | Headings, body text |
| Text secondary | `oklch(0.556 0 0)` | Labels, timestamps, metadata |
| Text tertiary | `oklch(0.708 0 0)` | Placeholders, disabled states |

### Dark Mode

| Token | Value | Purpose |
|---|---|---|
| Background | `oklch(0.145 0.015 250)` | Page background (deep charcoal, cool hint) |
| Glass surface | `bg-white/5` | Panel backgrounds with blur |
| Glass border | `border-white/10` | Panel edges |
| Text primary | `oklch(0.985 0 0)` | Headings, body text |
| Text secondary | `oklch(0.708 0 0)` | Labels, timestamps, metadata |
| Text tertiary | `oklch(0.556 0 0)` | Placeholders, disabled states |

### Implementation

All colors use CSS custom properties in `globals.css` mapped through Tailwind's `@theme`. When adding new color tokens, define them in both `:root` and `.dark` using `oklch()` values.

---

## Typography

### Font

- **Body / UI:** `DM Sans` (loaded via `next/font/google`) — geometric, warm, friendly, excellent at small sizes
- **No monospace in UI text.** Monospace (`Geist Mono`) is reserved for code snippets only
- **No decorative fonts.** The entire interface uses a single typeface family

### Scale

| Element | Size | Weight | Line Height |
|---|---|---|---|
| Page heading | `text-2xl` (24px) | `font-semibold` | `tight` |
| Section heading | `text-lg` (18px) | `font-semibold` | `snug` |
| Card title | `text-base` (16px) | `font-medium` | `snug` |
| Body text | `text-sm` (14px) | `font-normal` | `relaxed` |
| Metadata / labels | `text-xs` (12px) | `font-normal` | `normal` |

### Rules

- **Truncate, don't wrap aggressively.** Long text (email subjects, names) uses `truncate` or `line-clamp-2`, never unbounded wrapping that breaks layout
- **Letter spacing:** Default (`tracking-normal`) everywhere. Only tighten (`tracking-tight`) on large headings
- **No ALL CAPS for UI labels.** Use sentence case or title case. Caps only for abbreviations (API, URL)

---

## Layout

### Dashboard Shell

The dashboard uses a floating panel layout, not a sidebar + content split:

- **Navigation:** A floating glass bar (not edge-stretched) or a glass sidebar with margin from the viewport edge
- **Content area:** Panels float on the page background, never stretch to viewport edges
- **Page margins:** Minimum `p-6` (24px) on desktop, `p-4` (16px) on mobile
- **Panel max-width:** Content panels cap at `max-w-3xl` or `max-w-4xl` — wide screens should not produce wide content

### Grid

- **Single column default.** Most views are a single column of stacked panels
- **Two columns only when it adds clarity.** Side-by-side only for comparison or master-detail patterns
- **No dense grids.** Avoid 3+ column layouts entirely

### Spacing

- **Panel gaps:** `gap-6` (24px) between panels
- **Internal padding:** `p-6` (24px) inside panels, `p-4` (16px) for dense lists
- **Consistent rhythm:** All spacing is a multiple of 4px (Tailwind default scale)
- **Whitespace is a feature.** Empty space communicates hierarchy better than dividers or labels

---

## Components

### Cards / Panels

Every content container is a glass panel:

```tsx
<GlassPanel>
  <GlassPanel.Header title="Email">
    <Button variant="ghost" size="sm">Compose</Button>
  </GlassPanel.Header>
  <GlassPanel.Content>
    {/* content */}
  </GlassPanel.Content>
</GlassPanel>
```

- Cards have a header (title + optional action), content area, and optional footer
- Footer is visually separated with a subtle divider, not a background color change
- Cards are never nested more than 1 level deep

### Buttons

- **Primary:** Solid accent color, rounded-full, small padding. Used sparingly (main action per view)
- **Secondary:** Glass-style (transparent with border). Default for most buttons
- **Ghost:** No border, hover-only background. Used in toolbars, card headers
- **Destructive:** Red text only (no red background). Confirm in a dialog
- All buttons: `rounded-full` or `rounded-xl` — never square, never `rounded-sm`

### Inputs

- **Style:** Glass input — transparent background, subtle border, no heavy backgrounds
- **Focus:** Ring uses accent color at low opacity (`ring-accent/20`), border becomes accent
- **Height:** `h-10` (40px) standard, `h-9` (36px) for compact forms
- **No floating labels.** Labels sit above inputs, never inside

### Lists

- **Row height:** Minimum `h-12` (48px) for touch targets
- **Hover state:** Subtle glass highlight (`bg-white/20 dark:bg-white/5`), no color shift
- **Active/selected:** Accent left border (`border-l-2 border-accent`) or subtle accent background
- **Dividers:** `border-border/50` between rows, no divider on first/last item
- **Avatars:** Rounded (`rounded-full`), small (`w-8 h-8`), with status indicator if applicable

### Badges / Tags

- **Style:** Pill-shaped (`rounded-full`), small text (`text-xs`), glass background
- **Colors:** Semantic only — completed (green tint), pending (amber tint), overdue (red tint)
- **No decorative badges.** Every badge conveys status or categorization

---

## Motion

### Principles

- **Subtle and purposeful.** Animations guide attention, they don't entertain
- **Duration:** 150ms for state changes (hover, focus), 200ms for transitions (panel open/close)
- **Easing:** `ease-out` for appearing, `ease-in` for disappearing. Never `linear`
- **No bouncing, no overshoot.** Use Tailwind's `transition-all duration-200 ease-out`

### Specific Patterns

- **Panel appear:** Fade in + slight upward translate (`animate-in fade-in slide-in-from-bottom-2`)
- **Hover:** Subtle scale or brightness shift, never color swap
- **Loading:** Skeleton screens with glass styling, not spinners
- **Page transitions:** Instant (Next.js navigation). No page-level animations

---

## Dark Mode

### Rules

- **Toggle is always accessible.** Theme switch in the navigation or settings, never buried
- **System preference respected.** Default to `prefers-color-scheme`, override on user choice
- **No flash of wrong theme.** Use `suppressHydrationWarning` on `<html>` and apply theme before render
- **Glass adapts.** Dark mode glass uses `bg-white/5` (not `bg-black/50`) — it should feel like looking through tinted glass, not a dark box
- **Contrast maintained.** All text meets WCAG AA minimum in both modes. Test with `oklch` lightness differences of at least 0.3 between text and surface

### Implementation

```tsx
// Theme provider wraps the app, applies class to <html>
// Use next-themes or a custom provider
// Toggle component uses a smooth transition on the class change
```

---

## What To Avoid

These are explicit anti-patterns. If you catch yourself doing any of these, stop and reconsider:

| Anti-pattern | Why | Alternative |
|---|---|---|
| Neon / glowing effects | Gamer aesthetic | Subtle shadows and blur |
| Gradient text | Attention-seeking | Solid color, good typography |
| Monospace UI text | Developer-tool vibe | Inter for everything |
| Heavy borders (2px+) | Boxed-in feeling | 1px borders with glass |
| Flat colored cards | No depth | Glass panels with backdrop-blur |
| Dense data tables | Enterprise crammed feel | Spacious lists, progressive detail |
| Excessive iconography | Visual noise | Icons only where they add clarity |
| Rainbow status colors | Distracting | Muted semantic colors |
| Animated backgrounds | Distracting | Static gradient or mesh |
| Terminal / code aesthetics | Wrong audience | Clean, friendly prose UI |
| Edge-to-edge panels | No breathing room | Margins, floating panels |
| Nested modals | Disorienting | Inline expansion or single modal |

---

## Component Library

The project uses **shadcn/ui** with Radix primitives. All custom components should:

1. Extend shadcn patterns, not reinvent them
2. Use the `cn()` utility from `@/lib/utils` for class merging
3. Accept `className` as a prop and merge with defaults
4. Support dark mode through CSS custom properties (not separate components)
5. Use Tailwind v4 utility classes (no arbitrary values unless necessary)

### Required Custom Components

These components should be built to the glass spec before dashboard pages:

- `GlassPanel` — Main content container with glass effect
- `GlassPanel.Header` — Panel header with title and action area
- `GlassPanel.Content` — Panel content area
- `GlassPanel.Footer` — Panel footer with divider
- `GlassInput` — Glass-styled input field
- `GlassButton` — Glass-styled button variants
- `ThemeToggle` — Light/dark mode switcher
- `DashboardShell` — Dashboard layout with floating navigation

---

## Review Checklist

Before committing any UI change, verify:

- [ ] Panels use glass styling (transparency + blur + subtle border)
- [ ] No edge-to-edge content (panels float with margins)
- [ ] Text uses Inter, correct scale and weight
- [ ] Colors use CSS custom properties (not hardcoded hex/rgb)
- [ ] Dark mode tested and verified
- [ ] No anti-patterns from the table above
- [ ] Spacing follows the 4px rhythm
- [ ] Interactive elements have clear hover/focus states
- [ ] Animations are subtle (≤200ms, ease-out)
- [ ] The view is scannable — a user understands the page in 3 seconds
