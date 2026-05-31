# GlassPanel Component

## Overview

The `GlassPanel` is the primary content container in Saale. Every section of the dashboard lives inside a glass panel.

## Installation

Create the component at `src/components/ui/glass-panel.tsx`:

```tsx
import * as React from "react";
import { cn } from "@/lib/utils";

function GlassPanel({ className, children, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "glass-panel relative flex flex-col overflow-hidden rounded-2xl border border-white/20 dark:border-white/10 bg-white/60 dark:bg-white/5 backdrop-blur-xl shadow-lg",
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
}

function GlassPanelHeader({
  className,
  title,
  action,
  children,
  ...props
}: React.ComponentProps<"div"> & { title?: string; action?: React.ReactNode }) {
  return (
    <div
      className={cn(
        "flex items-center justify-between border-b border-border/50 px-6 py-4",
        className
      )}
      {...props}
    >
      <h2 className="text-lg font-semibold leading-snug">
        {title || children}
      </h2>
      {action && <div>{action}</div>}
    </div>
  );
}

function GlassPanelContent({ className, children, ...props }: React.ComponentProps<"div">) {
  return (
    <div className={cn("px-6 py-4", className)} {...props}>
      {children}
    </div>
  );
}

function GlassPanelFooter({ className, children, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex items-center justify-between border-t border-border/50 bg-white/30 dark:bg-white/5 px-6 py-3",
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export { GlassPanel, GlassPanelHeader, GlassPanelContent, GlassPanelFooter };
```

## Usage

### Basic Panel

```tsx
import { GlassPanel, GlassPanelHeader, GlassPanelContent } from "@/components/ui/glass-panel";

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
    action={<Button variant="secondary" size="sm">New Task</Button>}
  />
  <GlassPanelContent>
    {/* task list */}
  </GlassPanelContent>
</GlassPanel>
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
  </GlassPanelContent>
</GlassPanel>
```

### Panel Without Header (Content Only)

```tsx
<GlassPanel>
  <GlassPanelContent>
    {/* content without a header bar */}
  </GlassPanelContent>
</GlassPanel>
```

## Variants

### Subtle Panel

For inline elements that need slight separation:

```tsx
className="glass-panel-subtle border border-white/10 dark:border-white/5 bg-white/30 dark:bg-white/5 backdrop-blur-lg rounded-xl shadow-none"
```

### Deep Panel

For modals or overlays that need to stand out:

```tsx
className="glass-panel-deep border border-white/30 dark:border-white/10 bg-white/80 dark:bg-black/40 backdrop-blur-2xl rounded-3xl shadow-xl"
```

## Rules

- **Never nest GlassPanels more than 1 level deep.** If you need nesting, use a subtle inner div instead.
- **Always use `GlassPanelContent` for padding consistency.** Don't add arbitrary `p-*` classes to the panel itself.
- **Headers always have `border-b`.** This separates the title from content.
- **Footers always have `border-t` and a subtle background.** This separates actions from content.
- **Max one header action.** If you need multiple actions, use a dropdown or toolbar.

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
