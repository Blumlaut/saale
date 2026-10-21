# GlassPanel Component

## Overview

The `GlassPanel` is the primary content container in Saale. Every section of the dashboard lives inside a glass panel.

**All panels use the flat console surface by default.** The `GlassPanel` component applies both `glass-panel` and `liquid-glass` classes automatically (legacy names — they render as a flat, opaque, border-defined surface, not glass). You should never need to add `liquid-glass` manually to a `GlassPanel`.

## Component Signature

```tsx
import { GlassPanel, GlassPanelHeader, GlassPanelContent, GlassPanelFooter } from "@/components/ui/glass-panel";
```

The base `GlassPanel` applies: `glass-panel liquid-glass` — solid `bg-card`, 1px `border-border`, `rounded-2xl`. No blur, no transparency.

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

All overlay surfaces use the flat `liquid-glass` surface (solid `bg-popover` + 1px border + elevation shadow) by default:

| Component         | Surface Applied |
| ----------------- | ------------- |
| `DialogContent`   | ✅ `liquid-glass` |
| `AlertDialogContent` | ✅ `liquid-glass` |
| `SheetContent`    | ✅ `liquid-glass` |
| `PopoverContent`  | ✅ `liquid-glass` |
| `DropdownMenuContent` | ✅ `liquid-glass` |
| `SelectContent`   | ✅ `liquid-glass` |
| `TabsList`        | ✅ `liquid-glass-inner` |

**Never add `liquid-glass` manually to these components** — it's baked into the base styling.

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

For nested content areas inside panels, use `liquid-glass-inner` (renders as a flat muted inset with 1px border):

```tsx
<div className="liquid-glass-inner rounded-2xl border-0 p-4">
  {/* nested card-like content */}
</div>
```

For buttons, badges, and toggles, use `liquid-glass-pill` or `liquid-glass-accent` (flat fills, rectangular `rounded-lg` buttons):

```tsx
<Button className="liquid-glass-pill">Secondary Button</Button>
<Button className="liquid-glass-accent">Accent Button</Button>
```

## Rules

- **Never add `liquid-glass` manually to `GlassPanel`** — it's automatic.
- **Never nest GlassPanels more than 1 level deep.** If you need nesting, use `liquid-glass-inner` div instead.
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
