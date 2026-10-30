# GlassPanel Component

## Overview

The `GlassPanel` is the primary content container in Saale. Every section of the dashboard lives inside a glass panel.

**All panels use the flat console surface by default.** The `GlassPanel` component applies the `glass-panel` class: a solid `bg-card`, a 1px `border-border` and `rounded-2xl`. Never add a surface class to a `GlassPanel` by hand.

## Component Signature

```tsx
import { GlassPanel, GlassPanelHeader, GlassPanelContent, GlassPanelFooter } from "@/components/ui/glass-panel";
```

The base `GlassPanel` applies: `glass-panel` — solid `bg-card`, 1px `border-border`, `rounded-2xl`. No blur, no transparency.

## Usage

### Basic Panel

```tsx
export function MyView() {
  return (
    <GlassPanel>
      <GlassPanelHeader title="Inbox" />
      <GlassPanelContent>
        <p>Email content here</p>
      </GlassPanelContent>
    </GlassPanel>
  );
}
```

### Panel with Header Action

```tsx
import { Button } from "@/components/ui/button";

<GlassPanel>
  <GlassPanelHeader
    title="Tasks"
    action={
      <Button variant="secondary" size="sm">
        New Task
      </Button>
    }
  />
  <GlassPanelContent>{/* task list */}</GlassPanelContent>
</GlassPanel>;
```

### Panel with Footer

```tsx
<GlassPanel>
  <GlassPanelHeader title="Settings" />
  <GlassPanelContent>
    {/* form fields */}
  </GlassPanelContent>
  <GlassPanelFooter>
    <Button variant="ghost">Cancel</Button>
    <Button variant="default">Save Changes</Button>
  </GlassPanelFooter>
</GlassPanel>;
```

### Panel Without Header (Content Only)

```tsx
<GlassPanel>
  <GlassPanelContent>{/* content without a header bar */}</GlassPanelContent>
</GlassPanel>
```

### Remove Border (when inside another panel)

```tsx
<GlassPanel className="border-0">
  <GlassPanelContent>{/* nested content */}</GlassPanelContent>
</GlassPanel>
```

## Overlay Surfaces (Dialogs, Sheets, Popovers, Dropdowns)

Every overlay is the flat popover surface: solid `bg-popover`, a 1px `border-border` and an elevation shadow. It is baked into the primitive:

| Component              | Surface                                  |
| ---------------------- | ---------------------------------------- |
| `DialogContent`        | `bg-popover border border-border` + shadow |
| `AlertDialogContent`   | `bg-popover border border-border` + shadow |
| `SheetContent`         | `bg-popover border border-border` + shadow |
| `PopoverContent`       | `bg-popover border border-border` + shadow |
| `DropdownMenuContent`  | `bg-popover border border-border` + shadow |
| `SelectContent`        | `bg-popover border border-border` + shadow |
| `TabsList`             | `bg-muted` (an inset, no border)          |

**Never add a surface fill to these components** — it is baked into their base styling.

### SheetContent Usage

```tsx
<SheetContent className="flex w-full flex-col overflow-hidden p-0 sm:w-[440px]">
  {/* content */}
</SheetContent>
```

### DialogContent Usage

```tsx
<DialogContent className="max-w-lg">
  <DialogHeader>
    <DialogTitle>Title</DialogTitle>
  </DialogHeader>
  {/* content */}
</DialogContent>
```

## Inner Elements

For nested content areas inside panels, use a muted inset: `bg-muted` with a 1px `border-border` when it needs an edge.

```tsx
<div className="bg-muted border-border rounded-2xl border p-4">
  {/* nested card-like content */}
</div>
```

Actions are `<Button>` variants, never painted by hand:

```tsx
<Button variant="secondary">Secondary Button</Button>
<Button>Accent Button</Button>
```

## Rules

- **Never add a surface class to `GlassPanel`** — it's automatic.
- **Never nest GlassPanels more than 1 level deep.** If you need nesting, use a `bg-muted border-border` div instead.
- **Always use `GlassPanelContent` for padding consistency.** Don't add arbitrary `p-*` classes to the panel itself.
- **One gutter per panel.** Header, content and footer share a 16px gutter, and a row list uses `px-4` so its text lines up with the header. A caller class (`p-0`, `p-3`, `py-16`) replaces the default at every width.
- **Headers always have `border-b`.** This separates the title from content.
- **Footers always have `border-t` and a subtle background.** This separates actions from content.
- **Max one header action.** If you need multiple actions, use a dropdown or toolbar.
- **Use `border-0` on GlassPanel when the border should be hidden** (e.g., inside a sheet or when adjacent panels share edges).

## Extending with shadcn Card

The GlassPanel replaces the shadcn `<Card>` component. If a shadcn pattern needs a card-like container, use GlassPanel instead:

```tsx
// Instead of:
<Card>
  <CardHeader><CardTitle>Title</CardTitle></CardHeader>
  <CardContent>Content</CardContent>
</Card>

// Use:
<GlassPanel>
  <GlassPanelHeader title="Title" />
  <GlassPanelContent>Content</GlassPanelContent>
</GlassPanel>
```
