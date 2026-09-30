---
name: saale-design
description: Saale's console (NASA-punk) UI design system. Use when building, styling, or reviewing any dashboard UI — panels, navigation, forms, lists, modals, buttons, inputs, or layout. Covers flat bordered surfaces, color tokens, typography, motion, dark mode, and shadcn/ui component usage. Not for non-UI tasks, backend logic, or database work.
---

# Saale Design System

## Overview

Saale uses a **console** visual language (NASA-punk): flat, opaque, border-defined panels on a solid background. No blur, no gradients, no glass. Depth comes from 1px borders, elevation shadows on overlays only, and a single mission accent — **orange**. The interface reads like a mission control console: calm, dense, instantly readable. It supports light and dark mode equally.

**Core rule:** Every UI element is built from shadcn/ui components. Never write raw HTML when a shadcn component exists.

## Intake

When the user asks for a UI element or page:

1. What view is it? (dashboard, mail, chat, tasks, settings, auth)
2. What components does it need? (panels, lists, forms, tables, modals)
3. Any special interactions? (drag, resize, inline edit)
4. Light mode, dark mode, or both? (default: both)

## Default Assumptions

- Both light and dark mode supported
- Desktop-first, responsive down to 320px
- shadcn/ui for all interactive components
- Flat bordered panels (`GlassPanel` — the name is legacy, the surface is flat)
- Inter for UI text, Geist Mono for data/console labels (code, IDs, timestamps, micro-labels)

## Quick Workflow

1. Load `references/design-philosophy.md` for principles and anti-patterns
2. Load the specific reference file(s) for the component(s) needed (see Reference Index below)
3. Load `references/shadcn-components.md` for component selection and installation
4. Build using shadcn primitives + console surface classes from `references/glass-surfaces.md`
5. Verify against `references/review-checklist.md`

## Reference Index (Load On-Demand)

### Foundation (Load First)

| Need                                  | File                              |
| ------------------------------------- | --------------------------------- |
| Principles, anti-patterns, philosophy | `references/design-philosophy.md` |
| Console surface implementation        | `references/glass-surfaces.md`    |
| Color tokens, palette rules           | `references/color-system.md`      |
| Typography scale, font rules          | `references/typography.md`        |
| Layout, spacing, panels               | `references/layout.md`            |
| Animation, transitions, loading       | `references/motion.md`            |
| Dark mode implementation              | `references/dark-mode.md`         |

### Components (Load When Building UI)

| Component                   | File                         |
| --------------------------- | ---------------------------- |
| GlassPanel (main container) | `references/glass-panel.md`  |
| Buttons (all variants)      | `references/buttons.md`      |
| Inputs, forms, selects      | `references/inputs.md`       |
| Lists, rows, tables         | `references/lists.md`        |
| Navigation, sidebar         | `references/navigation.md`   |
| Modals, dialogs, sheets     | `references/modals.md`       |
| Badges, tags, status        | `references/badges.md`       |
| Cards with media            | `references/cards.md`        |
| Empty states                | `references/empty-states.md` |

### Integration

| Need                        | File                              |
| --------------------------- | --------------------------------- |
| shadcn/ui component guide   | `references/shadcn-components.md` |
| Pre-commit review checklist | `references/review-checklist.md`  |
| globals.css token reference | `references/css-tokens.md`        |

## shadcn/ui First

**Every interactive element must use a shadcn/ui component.** This is not optional.

- Buttons → `<Button>` (not `<button>`)
- Inputs → `<Input>` (not `<input>`)
- Dialogs → `<Dialog>` (not custom overlay)
- Tabs → `<Tabs>` (not custom state)
- Selects → `<Select>` (not `<select>`)
- Checkboxes → `<Checkbox>` (not `<input type="checkbox">`)
- etc.

If a shadcn component doesn't exist for your need, check the registry first (`npx shadcn@latest add <component>`). Only write custom components when no shadcn equivalent exists.

See `references/shadcn-components.md` for the full mapping.

## Common Patterns

### Panel with Content

`GlassPanel` applies the flat console surface automatically — never add `liquid-glass` manually (the name is legacy; it is now a flat bordered surface, not glass).

```tsx
import { GlassPanel, GlassPanelHeader, GlassPanelContent } from "@/components/ui/glass-panel";
import { Button } from "@/components/ui/button";

export function MyView() {
  return (
    <GlassPanel>
      <GlassPanelHeader title="My Section">
        <Button variant="secondary" size="sm">
          Action
        </Button>
      </GlassPanelHeader>
      <GlassPanelContent>{/* content */}</GlassPanelContent>
    </GlassPanel>
  );
}
```

### List with Rows

Row hover/selected states use **token fills** (`bg-accent`, `bg-muted`), never `bg-white/N` overlays — those were a glass-system idiom and look broken on flat surfaces.

```tsx
import { GlassPanel, GlassPanelHeader, GlassPanelContent } from "@/components/ui/glass-panel";
import { Separator } from "@/components/ui/separator";

export function MyList() {
  return (
    <GlassPanel>
      <GlassPanelHeader title="Items" />
      <GlassPanelContent className="p-0">
        {items.map((item, i) => (
          <Fragment key={item.id}>
            <div className="flex cursor-pointer items-center gap-3 px-4 py-3 transition-colors hover:bg-accent/60">
              {/* row content */}
            </div>
            {i < items.length - 1 && <Separator className="px-4" />}
          </Fragment>
        ))}
      </GlassPanelContent>
    </GlassPanel>
  );
}
```

### Page Layout (App Shell) — ALWAYS use these

Every dashboard/admin page is a fixed-height shell (`h-dvh overflow-hidden`); the
body **never scrolls**. Pages must use the shared layout components in
`src/components/layout/page.tsx` — never build a page root by hand:

```tsx
import { Page, PageToolbar, PageScroll, PageTabStrip } from "@/components/layout/page";

export default function MyPage() {
  return (
    <Page>
      <PageToolbar title="My Page">
        {/* icon-only on mobile, label at md: */}
        <Button size="icon" className="h-8 w-8 md:h-9 md:w-auto md:px-3" onClick={...}>
          <Plus className="h-4 w-4" />
          <span className="hidden md:inline">New Item</span>
        </Button>
      </PageToolbar>
      <PageScroll>
        {/* tall content scrolls here — the ONLY scroll region */}
      </PageScroll>
    </Page>
  );
}
```

Rules:

- **No title/subtitle headers** — two-line title+description rows are wasted vertical space.
  A page may pin at most a compact **one-line header**: title left, actions right, no subtitle.
  Pages without actions start straight at their content.
- **Actions pinned** — `PageToolbar` is `shrink-0`; actions (buttons) never scroll away.
- **Content scrolls inside `PageScroll`** (`min-h-0 flex-1 overflow-y-auto`) — the
  only scrollable region on the page.
- **Tab pages** — put the strip in `PageTabStrip` (pinned, swipe-scrollable,
  hidden scrollbar) and the tab content in `PageScroll`:
  `<Tabs className="flex min-h-0 flex-1 flex-col">` + `<TabsContent className="min-h-0 flex-1 overflow-y-auto">`.
- **Never** use `h-dvh`, `h-screen`, or `calc(100vh - X)` on page components.
- **Never** put `w-full` on a `TabsList` with many tabs — triggers squeeze and
  labels overlap. Keep it `w-fit` (default) inside `PageTabStrip`.
- Grid items containing lists/tables need `min-w-0` (`lg:col-span-2` →
  `min-w-0 lg:col-span-2`) so nowrap text truncates instead of blowing the grid
  track wider than the viewport.

The e2e suite (`e2e/mobile-overflow.spec.ts`) enforces all of this at 375px and
320px — a page that regresses fails CI.

Overlays follow the same rule inside their own box: `e2e/modal-overflow.spec.ts`
opens every registered modal at both widths and fails if one scrolls horizontally
or lets content escape its bounds. Register new overlays in
`e2e/modal-scenarios.ts` (`__tests__/overlay-coverage.test.ts` fails otherwise)
and never use a bare `grid` inside an overlay — see
[references/modals.md](references/modals.md).

### Unified Console Surfaces

All overlay surfaces include `liquid-glass` by default (legacy name — it renders as a flat bordered popover surface with an elevation shadow, no blur) — no manual class needed:

- `DialogContent` → flat bordered surface
- `AlertDialogContent` → flat bordered surface
- `SheetContent` → flat bordered surface
- `PopoverContent` → flat bordered surface
- `DropdownMenuContent` → flat bordered surface
- `SelectContent` → flat bordered surface
- `TabsList` → flat bordered inner

For nested content inside panels, use `liquid-glass-inner` on a plain `<div>` (renders as a flat muted inset).

## Console Micro-Labels

Section labels, panel footers, and metadata use the `.console-label` class — small caps, wide tracking, muted color (`10px / 600 / 0.18em uppercase`). The sidebar footer (`SALE v0.1.0`) and the orange tick under it are the canonical example. Use for: section headers inside panels, status lines, version info. **Do not** use for body text or button labels.

## Anti-Patterns (Never Do These)

| Anti-pattern             | Why                                      | Alternative                            |
| ------------------------ | ---------------------------------------- | -------------------------------------- |
| Raw HTML elements        | Inconsistent styling, no accessibility   | shadcn/ui components                   |
| `bg-white/N` overlay fills | Glass idiom — invisible or wrong on flat panels in one of the modes | Token fills: `bg-accent`, `bg-muted` |
| `backdrop-blur` on panels | Glass residue — console surfaces are opaque | Remove it; borders carry the depth   |
| Gradients / glows        | Not the console language                 | Flat colors + 1px borders              |
| Pill-shaped buttons      | Old design                               | `rounded-lg` (12px) rectangular        |
| Rainbow status colors    | Distracting                              | Muted semantic colors, orange = primary action only |
| ALL CAPS body text       | Aggressive                               | Sentence case (micro-labels excepted)  |
| Monospace UI text        | Developer-tool vibe (except data)        | Inter for UI; Geist Mono for data, IDs, timestamps, micro-labels |
| Animated backgrounds     | Distracting                              | Static solid background                |

## Review Checklist

Before committing any UI change, verify `references/review-checklist.md`.

## Search Tips

- Find flat surface classes: `rg "liquid-glass|glass-panel" src/components/`
- Find leftover glass idioms: `rg "bg-white/\d|backdrop-blur" src/`
- Find color token usage: `rg "var\(--" src/app/globals.css`
- Find shadcn component imports: `rg "from \"@/components/ui\"" src/`
