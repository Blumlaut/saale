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
  <SheetContent className="liquid-glass flex w-[440px] flex-col overflow-hidden border-0 bg-transparent p-0 shadow-2xl sm:max-w-none">
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
- **Width:** `w-[440px]` standard, `dark:w-[460px]` for slightly more room in dark mode
- **Liquid glass:** Use the `liquid-glass` class on `SheetContent` for the Apple-style frosted glass look
- **Structure:** Header (border-b) → scrollable content → footer (border-t) — content scrolls, header/footer stay fixed
- **Close:** Use the built-in `showCloseButton` (default true) — don't add manual close buttons
- **Max one sheet at a time.** Never nest sheets or stack a sheet on a dialog.

### Sheet for Forms

```tsx
<SheetContent className="liquid-glass flex w-[440px] flex-col overflow-hidden border-0 bg-transparent p-0 shadow-2xl sm:max-w-none">
  <div className="flex h-full flex-col">
    <SheetHeader className="border-border/30 border-b px-6 pb-4 pt-6">
      <SheetTitle className="text-xl font-semibold leading-tight tracking-tight">
        New Event
      </SheetTitle>
    </SheetHeader>

    <div className="flex-1 overflow-y-auto px-6 py-5">
      <div className="space-y-4">
        {/* form fields with liquid-glass-inner inputs */}
        <Input className="liquid-glass-inner h-10 rounded-full px-4 border-0 bg-transparent shadow-none" />
      </div>
    </div>

    <div className="border-border/30 border-t px-6 py-4">
      <Button className="liquid-glass-accent h-9 w-full rounded-full text-xs font-medium">
        Create Event
      </Button>
    </div>
  </div>
</SheetContent>
```

### Sheet for Detail Views

```tsx
<SheetContent className="liquid-glass flex w-[440px] flex-col overflow-hidden border-0 bg-transparent p-0 shadow-2xl sm:max-w-none">
  <div className="flex h-full flex-col">
    <SheetHeader className="border-border/30 border-b px-6 pb-4 pt-6">
      <SheetTitle className="text-xl font-semibold leading-tight tracking-tight">
        Event Title
      </SheetTitle>
      <p className="mt-1 text-xs text-muted-foreground">Calendar Name</p>
    </SheetHeader>

    <div className="flex-1 overflow-y-auto px-6 py-5">
      {/* Info blocks in liquid-glass-inner cards */}
      <div className="liquid-glass-inner rounded-2xl px-4 py-4">
        {/* date, time, etc. */}
      </div>
    </div>

    <div className="border-border/30 border-t px-6 py-4">
      <div className="flex gap-2">
        <Button className="liquid-glass-destructive h-9 flex-1 rounded-full text-xs font-medium" variant="ghost">
          Delete
        </Button>
        <Button className="liquid-glass-accent h-9 flex-1 rounded-full text-xs font-medium">
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
  <AlertDialogContent className="liquid-glass border-0 bg-transparent">
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
  <DialogContent className="liquid-glass border-0 bg-transparent sm:max-w-sm">
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
| **Sheet** (default) | Forms, details, settings, editing, multi-step | Preserves context, liquid glass aesthetic |
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

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Dialog for forms | Use a Sheet instead |
| Dialog for detail views | Use a Sheet instead |
| Nested overlays | Use inline expansion or a single overlay |
| No glass styling | Apply `liquid-glass` class |
| Square buttons in overlays | Use `rounded-full` pills |
| Manual close button on sheet | Use built-in `showCloseButton` |
| Full-screen overlay | Use max-width and let background show |
| Scrollable header/footer | Keep header/footer fixed, only content scrolls |
