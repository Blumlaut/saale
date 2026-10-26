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

| Component                    | File                         |
| ---------------------------- | ---------------------------- |
| GlassPanel (main container)  | `references/glass-panel.md`  |
| Buttons (all variants)       | `references/buttons.md`      |
| Inputs, forms, selects       | `references/inputs.md`       |
| Lists, rows, tables          | `references/lists.md`        |
| Navigation, sidebar          | `references/navigation.md`   |
| Modals, dialogs, sheets      | `references/modals.md`       |
| Badges, tags, status         | `references/badges.md`       |
| Cards with media             | `references/cards.md`        |
| Tool cards (chat transcript) | `references/tool-cards.md`   |
| Empty states                 | `references/empty-states.md` |

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
            <div className="hover:bg-accent/60 flex cursor-pointer items-center gap-3 px-4 py-3 transition-colors">
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

### Density: A Component Dropped Into a Side Panel

A browser, list or card reused inside a side panel (the coder worktree panel, the
chat "Linked" panel) renders **dense**: `text-xs`, `py-1` rows, `gap-2`,
`px-2`, `h-3.5` icons. The panel's own gutter adds to the component's, so the
page-sized variant (`py-2.5 md:px-6`) turns a column into a full-page list.

- A component that appears both ways takes a `dense` prop and defaults to the
  page layout. `FileBrowser` is the reference.
- Never nest `GlassPanelContent` inside a `GlassPanel` inside a panel: its `md:`
  gutter doubles the padding on every row. Use a plain `min-h-0 flex-1
overflow-y-auto` div for the scroll region.
- The guard is `e2e/coder-panel.spec.ts` ("keeps the file rows tight"), which
  measures a row at ≤ 28px. A new side-panel list needs the same measurement.

### A File's Editor Lives in the Panel

A file opens in a tab of the resizable panel that holds the files (the coder
worktree panel). The panel is the one surface the user can drag wider, and
Monaco needs that width; a sheet has a fixed width and covers the chat the user
is working in.

- `FileBrowser` takes `onOpenFile` for a host with a panel: it hands the file
  over, and the worktree panel opens it as a tab with a close control and a
  download button.
- `FileView` is the shared body — Monaco for text, the code/preview toggle,
  markdown and HTML preview, the too-large and binary states. Use it in the tab
  and in the sheet, so both render a file the same way.
- The guard is `e2e/coder-panel.spec.ts` ("opens a file as a tab in the panel").

### Remembered View State

A view preference — a folded list group, a page tab, the file browser's
hidden files, the calendar mode — goes through `usePersistedState`
(`@/hooks/use-persisted-state`), so the next visit opens the way the last one
was left.

```ts
const [hideDotfiles, setHideDotfiles] = usePersistedState("files:hideDotfiles", true, {
  validate: isBoolean,
});
```

- Keys are short and named by area: `files:hideDotfiles`, `mail:tab`,
  `tasks:collapsedGroups`.
- Pass a guard (`isBoolean`, `oneOf(...)`, `arrayOf(...)`) so a value an older
  build left behind falls back to the default.
- A caller whose first fetch depends on the value waits for the third tuple
  element, `restored`.
- A per-visit decision (an open dialog, a search box, a selection) stays plain
  `useState`. Settings the user configures belong in the settings registry
  (`src/lib/settings/properties.ts`).

### Page Layout (App Shell) — ALWAYS use these

Every dashboard/admin page is a fixed-height shell (`h-dvh overflow-hidden`); the
body **never scrolls**. Pages must use the shared layout components in
`src/components/layout/page.tsx` — never build a page root by hand:

```tsx
// Any page with one panel — list, form, settings. The panel's first row is the
// action row, so the page never places its own button.
<Page className="gap-0">
  <GlassPanel className="flex h-full flex-col overflow-hidden border-0">
    <PageActions leading={/* search, count, filters, status */}>
      <PageAction icon={Plus} label="New Item" onClick={...} />
    </PageActions>
    <PageScroll>{/* the ONLY scroll region */}</PageScroll>
  </GlassPanel>
</Page>

// Several groups of settings share one panel as sections
<PageSection title="Signups">{/* rows */}</PageSection>

// A page of two panels puts the action in the first panel's header
<GlassPanelHeader title="Agent Jobs" action={<PageAction icon={Plus} label="New agent" />} />
```

`PageActions`, `PageAction`, `PageStatus` and `PageSection` live in `src/components/layout/page.tsx`. Never hand-roll the row or size the button yourself — a page that does drifts from every other page. `eslint.config.mjs` rejects a copied row or button, and `e2e/page-actions.spec.ts` measures the rendered result.

Rules:

- **No page titles** — the nav already names the page. No title text, no subtitle,
  no title+action rows. Empty space is wasted space.
- **The content owns the toolbar** — the page's first panel row holds the actions
  (right-aligned, icon-only on mobile, label at `md:`). Functional context (date
  range, account switcher, search) may sit on the left — never a bare page name.
- **One panel, one action row** — a page with a single panel puts everything in it,
  however many groups of settings it holds (`PageSection`). Its action row is that
  panel's first row. A page of two panels puts the action in the first panel's
  header.
- **Actions pinned** — the toolbar row is `shrink-0`; actions never scroll away.
- **Content scrolls inside its panel** (`min-h-0 flex-1 overflow-y-auto`) or inside
  `PageScroll` for form pages — the only scrollable region on the page.
- **Tab pages** — put the strip in `PageTabStrip` (pinned, swipe-scrollable,
  hidden scrollbar) and the tab content in `PageScroll`:
  `<Tabs className="flex min-h-0 flex-1 flex-col">` + `<TabsContent className="min-h-0 flex-1 overflow-y-auto">`.
- **Never** use `h-dvh`, `h-screen`, or `calc(100vh - X)` on page components.
- **Never** put `w-full` on a `TabsList` with many tabs — triggers squeeze and
  labels overlap. Keep it `w-fit` (default) inside `PageTabStrip`.
- Grid items containing lists/tables need `min-w-0` (`lg:col-span-2` →
  `min-w-0 lg:col-span-2`) so nowrap text truncates instead of blowing the grid
  track wider than the viewport.
- **Full-bleed views** — a view that _is_ the window (chat) marks its layout root
  `full-bleed`: on phones the shell gutter is dropped so it runs to the window
  edges and its panels are square. Desktop keeps the console gutter and rounded
  panels — there is room for the floating nav and the view. See
  [references/layout.md](references/layout.md).
- **Row actions survive touch** — never hide an action behind hover only; use
  `ROW_ACTION` from `@/lib/utils`, which stays visible for coarse pointers. See
  [references/lists.md](references/lists.md).

The e2e suite (`e2e/mobile-overflow.spec.ts`, `e2e/chat-full-bleed.spec.ts`)
enforces all of this at 375px and 320px — a page that regresses fails CI.

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

| Anti-pattern                           | Why                                                                       | Alternative                                                            |
| -------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Raw HTML elements                      | Inconsistent styling, no accessibility                                    | shadcn/ui components                                                   |
| `bg-white/N` overlay fills             | Glass idiom — invisible or wrong on flat panels in one of the modes       | Token fills: `bg-accent`, `bg-muted`                                   |
| `backdrop-blur` on panels              | Glass residue — console surfaces are opaque                               | Remove it; borders carry the depth                                     |
| Gradients / glows                      | Not the console language                                                  | Flat colors + 1px borders                                              |
| Pill-shaped buttons                    | Old design                                                                | `rounded-lg` (12px) rectangular                                        |
| Rainbow status colors                  | Distracting                                                               | Muted semantic colors, orange = primary action only                    |
| ALL CAPS body text                     | Aggressive                                                                | Sentence case (micro-labels excepted)                                  |
| Monospace UI text                      | Developer-tool vibe (except data)                                         | Inter for UI; Geist Mono for data, IDs, timestamps, micro-labels       |
| Animated backgrounds                   | Distracting                                                               | Static solid background                                                |
| Page-sized rows in a side panel        | The panel gutter adds to the component's, so a column scrolls like a page | `dense` variant: `text-xs`, `py-1`, `px-2`; measured in e2e            |
| An editor in a sheet or popover        | Its width is fixed and it hides the chat, and Monaco needs the room       | `FileBrowser` `onOpenFile` → a tab in the resizable panel (`FileView`) |
| A view preference in a bare `useState` | Forgotten on the next visit                                               | `usePersistedState`                                                    |

## Review Checklist

Before committing any UI change, verify `references/review-checklist.md`.

## Search Tips

- Find flat surface classes: `rg "liquid-glass|glass-panel" src/components/`
- Find leftover glass idioms: `rg "bg-white/\d|backdrop-blur" src/`
- Find color token usage: `rg "var\(--" src/app/globals.css`
- Find shadcn component imports: `rg "from \"@/components/ui\"" src/`
