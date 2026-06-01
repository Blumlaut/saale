# Modals, Dialogs, and Sheets

## Component

Always use shadcn/ui components:

```tsx
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "@/components/ui/drawer";
```

## Dialog (Modal)

For actions that require focus: confirmations, forms, detailed views.

### Basic Dialog

```tsx
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

<Dialog>
  <DialogTrigger asChild>
    <Button variant="secondary">Open Settings</Button>
  </DialogTrigger>
  <DialogContent className="sm:max-w-md">
    <DialogHeader>
      <DialogTitle>Settings</DialogTitle>
      <DialogDescription>Manage your account preferences.</DialogDescription>
    </DialogHeader>
    {/* Form or content */}
  </DialogContent>
</Dialog>;
```

### Confirmation Dialog

```tsx
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

<AlertDialog>
  <AlertDialogTrigger asChild>
    <Button variant="destructive">Delete Task</Button>
  </AlertDialogTrigger>
  <AlertDialogContent>
    <AlertDialogHeader>
      <AlertDialogTitle>Delete this task?</AlertDialogTitle>
      <AlertDialogDescription>
        This action cannot be undone. The task will be permanently removed.
      </AlertDialogDescription>
    </AlertDialogHeader>
    <AlertDialogFooter>
      <AlertDialogCancel>Cancel</AlertDialogCancel>
      <AlertDialogAction>Delete</AlertDialogAction>
    </AlertDialogFooter>
  </AlertDialogContent>
</AlertDialog>;
```

## Sheet (Side Panel)

For detail views that supplement the main content:

```tsx
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";

<Sheet>
  <SheetTrigger asChild>
    <Button variant="ghost">View Details</Button>
  </SheetTrigger>
  <SheetContent className="w-[400px] sm:w-[500px]">
    <SheetHeader>
      <SheetTitle>Email Details</SheetTitle>
    </SheetHeader>
    {/* Detail content */}
  </SheetContent>
</Sheet>;
```

### Sheet Rules

- **Side:** `side="right"` for details, `side="left"` for navigation (default)
- **Width:** 400px mobile, 500px desktop
- **Use for:** Detail views, side panels, expanded content
- **Not for:** Simple confirmations (use Dialog instead)

## When To Use What

| Pattern              | Use                                         | Why                              |
| -------------------- | ------------------------------------------- | -------------------------------- |
| **Dialog**           | Confirmations, small forms, alerts          | Centers focus, blocks background |
| **Sheet**            | Detail views, side panels, expanded content | Slides in, preserves context     |
| **Drawer**           | Mobile bottom sheet                         | Native mobile pattern            |
| **Inline expansion** | Reveal more details in a list item          | No modal needed                  |
| **Dropdown menu**    | Quick actions on an item                    | Lightweight, contextual          |

## Glass Styling

Dialogs and sheets should use deep glass styling:

```tsx
// Dialog
<DialogContent className="bg-white/80 dark:bg-black/40 backdrop-blur-2xl border border-white/30 dark:border-white/10 shadow-xl sm:max-w-md rounded-3xl">
  {/* content */}
</DialogContent>

// Sheet
<SheetContent className="bg-white/80 dark:bg-black/40 backdrop-blur-2xl border-l border-white/20 dark:border-white/10">
  {/* content */}
</SheetContent>
```

## Rules

- **Max one modal at a time.** Never nest modals.
- **Escape to close.** Both Dialog and Sheet support this by default.
- **Click outside to close.** Default behavior, don't disable unless critical.
- **Focus trap.** Handled by Radix primitives automatically.
- **Loading state.** Show a spinner inside the modal, don't show a blank modal.
- **Max height:** `max-h-[85vh]` with `overflow-y-auto` for long content.

## Common Mistakes

| Mistake                          | Fix                                    |
| -------------------------------- | -------------------------------------- |
| Nested modals                    | Use inline expansion or a single modal |
| Modal for simple detail          | Use a Sheet instead                    |
| No close mechanism               | Radix handles this, but verify         |
| Full-screen modal                | Use max-width and max-height           |
| No glass styling on modal        | Add backdrop-blur and transparency     |
| Confirmation without AlertDialog | Use AlertDialog, not Dialog            |
