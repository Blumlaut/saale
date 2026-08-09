---
name: saale-design
description: Saale's liquid glass UI design system. Use when building, styling, or reviewing any dashboard UI — panels, navigation, forms, lists, modals, buttons, inputs, or layout. Covers glass surfaces, color tokens, typography, motion, dark mode, and shadcn/ui component usage. Not for non-UI tasks, backend logic, or database work.
---

# Saale Design System

## Overview

Saale uses a **liquid glass** visual language — translucent, blurred, floating panels over a soft gradient background. The interface is calm, spacious, and instantly readable. It supports light and dark mode equally.

**Core rule:** Every UI element is built from shadcn/ui components, extended with glass styling. Never write raw HTML when a shadcn component exists.

## Intake

When the user asks for a UI element or page:

1. What view is it? (dashboard, mail, chat, tasks, settings, auth)
2. What components does it need? (panels, lists, forms, tables, modals)
3. Any special interactions? (drag, resize, inline edit)
4. Light mode, dark mode, or both? (default: both)

## Default Assumptions

- Both light and dark mode supported
- Desktop-first, responsive down to 768px
- shadcn/ui for all interactive components
- Glass styling on all content panels
- DM Sans for all UI text

## Quick Workflow

1. Load `references/design-philosophy.md` for principles and anti-patterns
2. Load the specific reference file(s) for the component(s) needed (see Reference Index below)
3. Load `references/shadcn-components.md` for component selection and installation
4. Build using shadcn primitives + glass styling from `references/glass-surfaces.md`
5. Verify against `references/review-checklist.md`

## Reference Index (Load On-Demand)

### Foundation (Load First)

| Need                                  | File                              |
| ------------------------------------- | --------------------------------- |
| Principles, anti-patterns, philosophy | `references/design-philosophy.md` |
| Glass surface implementation          | `references/glass-surfaces.md`    |
| Color tokens, palette rules           | `references/color-system.md`      |
| Typography scale, font rules          | `references/typography.md`        |
| Layout, spacing, floating panels      | `references/layout.md`            |
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

### Glass Panel with Content

`GlassPanel` applies `glass-panel liquid-glass` automatically — never add `liquid-glass` manually.

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
            <div className="flex cursor-pointer items-center gap-3 px-4 py-3 transition-colors hover:bg-white/20 dark:hover:bg-white/5">
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
import { Page, PageHeader, PageScroll, PageTabStrip } from "@/components/layout/page";

export default function MyPage() {
  return (
    <Page>
      <PageHeader title="My Page" description="What it does" actions={<Button>Act</Button>} />
      <PageScroll>
        {/* tall content scrolls here — the ONLY scroll region */}
      </PageScroll>
    </Page>
  );
}
```

Rules:

- **Header pinned** — `PageHeader` is `shrink-0`; actions (buttons) never scroll away.
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

### Unified Glass Surfaces

All overlay surfaces include `liquid-glass` by default — no manual class needed:

- `DialogContent` → liquid glass
- `AlertDialogContent` → liquid glass
- `SheetContent` → liquid glass
- `PopoverContent` → liquid glass
- `DropdownMenuContent` → liquid glass
- `SelectContent` → liquid glass
- `TabsList` → liquid glass inner

For nested content inside panels, use `liquid-glass-inner` on a plain `<div>`.

## Anti-Patterns (Never Do These)

| Anti-pattern           | Why                                    | Alternative                     |
| ---------------------- | -------------------------------------- | ------------------------------- |
| Raw HTML elements      | Inconsistent styling, no accessibility | shadcn/ui components            |
| Neon / glowing effects | Gamer aesthetic                        | Subtle shadows and blur         |
| Monospace UI text      | Developer-tool vibe                    | Inter for everything            |
| Hard borders (2px+)    | Boxed-in feeling                       | 1px glass borders               |
| Flat colored cards     | No depth                               | Glass panels with backdrop-blur |
| Edge-to-edge panels    | No breathing room                      | Margins, floating panels        |
| Rainbow status colors  | Distracting                            | Muted semantic colors           |
| ALL CAPS labels        | Aggressive                             | Sentence case                   |
| Square buttons         | Harsh                                  | `rounded-full` or `rounded-xl`  |
| Animated backgrounds   | Distracting                            | Static gradient                 |

## Review Checklist

Before committing any UI change, verify `references/review-checklist.md`.

## Search Tips

- Find a glass class: `rg "backdrop-blur" src/components/`
- Find color token usage: `rg "var\(--" src/app/globals.css`
- Find shadcn component imports: `rg "from \"@/components/ui\"" src/`
