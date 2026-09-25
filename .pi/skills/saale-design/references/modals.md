# Sheets, Dialogs, and Overlays

## Default: Sheets Over Dialogs

**Saale prefers sheets over centered dialogs for nearly everything.** Sheets preserve the user's context — the main content stays visible behind the overlay. Centered dialogs are reserved for truly blocking actions.

| Use | When |
|-----|------|
| **Sheet** (default) | Forms, detail views, settings panels, event creation/editing, account management, subscription management |
| **AlertDialog** | Destructive confirmations (delete, remove, irreversible actions) |
| **Dialog** | Rare — only for simple, atomic prompts that need absolute focus (e.g., "Are you sure?") |

**Rule of thumb:** If the user might want to reference the main content while interacting with the overlay, it's a sheet.

## Component

Always use shadcn/ui components:

```tsx
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
```

## Sheet (Side Panel) — Primary Overlay

Slides in from the right. The default overlay for forms, details, and multi-step interactions.

### Basic Sheet

```tsx
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";

<Sheet open={open} onOpenChange={setOpen}>
  <SheetContent className="flex w-[440px] flex-col overflow-hidden p-0 sm:max-w-none">
    <div className="flex h-full flex-col">
      {/* Header */}
      <SheetHeader className="border-border/30 border-b px-6 pb-4 pt-6">
        <SheetTitle className="text-xl font-semibold leading-tight tracking-tight">
          Title
        </SheetTitle>
      </SheetHeader>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto px-6 py-5">
        {/* form or detail content */}
      </div>

      {/* Sticky footer */}
      <div className="border-border/30 border-t px-6 py-4">
        {/* action buttons */}
      </div>
    </div>
  </SheetContent>
</Sheet>;
```

### Sheet Rules

- **Side:** Always `side="right"` (default) — never left for content panels
- **Width:** `w-[440px]` standard
- **Surface:** `liquid-glass` is baked into the base `SheetContent` — flat `bg-popover`, 1px `border-border`, elevation shadow. Never add it manually, and never `border-0`/`bg-transparent`
- **Structure:** Header (border-b) → scrollable content → footer (border-t) — content scrolls, header/footer stay fixed
- **Close:** Use the built-in `showCloseButton` (default true) — don't add manual close buttons
- **Max one sheet at a time.** Never nest sheets or stack a sheet on a dialog.

### Sheet for Forms

```tsx
<SheetContent className="flex w-[440px] flex-col overflow-hidden p-0 sm:max-w-none">
  <div className="flex h-full flex-col">
    <SheetHeader className="border-b px-6 pb-4 pt-6">
      <SheetTitle className="text-xl font-semibold leading-tight tracking-tight">
        New Event
      </SheetTitle>
    </SheetHeader>

    <div className="flex-1 overflow-y-auto px-6 py-5">
      <div className="space-y-4">
        {/* plain flat inputs — the base Input is already console-styled */}
        <Input placeholder="Event title" />
      </div>
    </div>

    <div className="border-t px-6 py-4">
      <Button className="h-9 w-full text-xs font-medium">
        Create Event
      </Button>
    </div>
  </div>
</SheetContent>
```

### Sheet for Detail Views

```tsx
<SheetContent className="flex w-[440px] flex-col overflow-hidden p-0 sm:max-w-none">
  <div className="flex h-full flex-col">
    <SheetHeader className="border-b px-6 pb-4 pt-6">
      <SheetTitle className="text-xl font-semibold leading-tight tracking-tight">
        Event Title
      </SheetTitle>
      <p className="mt-1 text-xs text-muted-foreground">Calendar Name</p>
    </SheetHeader>

    <div className="flex-1 overflow-y-auto px-6 py-5">
      {/* Info blocks in flat liquid-glass-inner cards */}
      <div className="liquid-glass-inner rounded-xl px-4 py-4">
        {/* date, time, etc. */}
      </div>
    </div>

    <div className="border-t px-6 py-4">
      <div className="flex gap-2">
        <Button className="h-9 flex-1 text-xs font-medium" variant="destructive">
          Delete
        </Button>
        <Button className="h-9 flex-1 text-xs font-medium">
          Edit
        </Button>
      </div>
    </div>
  </div>
</SheetContent>
```

## AlertDialog — Destructive Confirmations Only

Use for actions that cannot be undone. Never use for simple "are you sure?" on reversible actions.

```tsx
<AlertDialog open={open} onOpenChange={setOpen}>
  <AlertDialogContent>
    <AlertDialogHeader>
      <AlertDialogTitle>Delete this event?</AlertDialogTitle>
      <AlertDialogDescription>
        This action cannot be undone. The event will be permanently removed.
      </AlertDialogDescription>
    </AlertDialogHeader>
    <AlertDialogFooter>
      <AlertDialogCancel>Cancel</AlertDialogCancel>
      <AlertDialogAction className="bg-destructive text-destructive-foreground">
        Delete
      </AlertDialogAction>
    </AlertDialogFooter>
  </AlertDialogContent>
</AlertDialog>;
```

## Dialog — Rare, Atomic Prompts

Centered dialogs are the least preferred overlay. Only use when:
- The action is atomic (single decision, no form)
- The user must not see the background content
- A sheet would feel too heavy

```tsx
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

<Dialog open={open} onOpenChange={setOpen}>
  <DialogContent className="sm:max-w-sm">
    <DialogHeader>
      <DialogTitle>Title</DialogTitle>
    </DialogHeader>
    {/* minimal content */}
  </DialogContent>
</Dialog>;
```

## When To Use What

| Pattern | Use | Why |
|---------|-----|-----|
| **Sheet** (default) | Forms, details, settings, editing, multi-step | Preserves context, flat console surface |
| **AlertDialog** | Delete, remove, irreversible actions | Blocks focus, clear danger signal |
| **Dialog** | Rare — atomic prompts only | Absolute focus, minimal interaction |
| **Inline expansion** | Reveal more details in a list item | No overlay needed |
| **Dropdown menu** | Quick actions on an item | Lightweight, contextual |

## Rules

- **Max one overlay at a time.** Never nest overlays of any kind.
- **Escape to close.** Both Sheet and Dialog support this by default.
- **Click outside to close.** Default behavior, don't disable unless critical.
- **Focus trap.** Handled by Radix primitives automatically.
- **Loading state.** Show a spinner inside the overlay, don't show a blank overlay.
- **Scrollable content, fixed header/footer.** Use `flex-1 overflow-y-auto` for the content area.
- **Never scroll horizontally.** The modal must fit its bounds at 320px — long unbreakable values (keys, tokens, URLs, IDs) wrap with `break-all` / `whitespace-pre-wrap`, and grids declare a base track (`grid-cols-1`, not a bare `grid`). Register every new overlay in `e2e/modal-scenarios.ts`: `e2e/modal-overflow.spec.ts` and `__tests__/overlay-coverage.test.ts` enforce this.

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Dialog for forms | Use a Sheet instead |
| Dialog for detail views | Use a Sheet instead |
| Nested overlays | Use inline expansion or a single overlay |
| Removing the overlay border | Keep the 1px `border-border` (baked in) — `border-0` is a glass-era mistake |
| Pill buttons in overlays | `rounded-lg` — the base Button already does this |
| Manual close button on sheet | Use built-in `showCloseButton` |
| Full-screen overlay | Use max-width and let background show |
| Scrollable header/footer | Keep header/footer fixed, only content scrolls |
| Modal wider than its bounds / horizontal scrollbar in a modal | Wrap the offending value (`break-all`), add `min-w-0` to the squashed row, give grids a base track (`grid-cols-1`) |
| Icon-only trigger button with no name | Add `aria-label` (and `title` when it needs a tooltip) |
