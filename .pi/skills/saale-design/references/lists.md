# Lists and Tables

## Component

Use shadcn/ui components for list elements:

```tsx
import { Separator } from "@/components/ui/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
```

## Simple List

The most common pattern — a list of items inside a GlassPanel:

```tsx
import { GlassPanel, GlassPanelHeader, GlassPanelContent } from "@/components/ui/glass-panel";
import { Separator } from "@/components/ui/separator";

export function EmailList({ emails }) {
  return (
    <GlassPanel>
      <GlassPanelHeader title="Inbox" />
      <GlassPanelContent className="p-0">
        {emails.map((email, i) => (
          <Fragment key={email.id}>
            <a
              href={`/dashboard/mail/${email.id}`}
              className="flex items-center gap-3 px-4 py-3 transition-colors duration-150 hover:bg-accent/60"
            >
              <Avatar>
                <AvatarFallback>{email.sender[0]}</AvatarFallback>
              </Avatar>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{email.subject}</p>
                <p className="text-muted-foreground truncate text-xs">{email.preview}</p>
              </div>
              <span className="text-muted-foreground shrink-0 text-xs">{email.time}</span>
            </a>
            {i < emails.length - 1 && <Separator className="px-4" />}
          </Fragment>
        ))}
      </GlassPanelContent>
    </GlassPanel>
  );
}
```

### List Row Rules

- **Min height:** 48px (`py-3` with content = ~48px touch target)
- **Hover state:** `hover:bg-accent/60` (token fill — never `bg-white/N`)
- **Transition:** `transition-colors duration-150`
- **Dividers:** `<Separator className="px-4" />` between rows (not on first/last)
- **Truncation:** `truncate` on text that might be long
- **Gap:** `gap-3` (12px) between row elements

## Dense List

For lists where more items visible is important:

```tsx
className = "flex items-center gap-2 px-4 py-2 hover:bg-accent/60";
```

- Min height: 40px
- Smaller text: `text-xs` for secondary info
- Use for: Settings lists, navigation items

## Selected / Active State

```tsx
className={cn(
  "flex items-center gap-2 rounded-lg px-3 py-2 transition-colors duration-150 cursor-pointer",
  isActive ? "bg-accent/70" : "hover:bg-accent/60"
)}
```

- `bg-accent/70` for the active item, `hover:bg-accent/60` for hover (token fills, both modes)
- For the main sidebar nav, the active state is the console treatment: dark fill + orange left tick (`border-l-2 border-primary`) — see `references/navigation.md`
- No color shift on hover (just brightness)

## Row Actions

Actions that belong to a row (its ⋯ menu, a delete button) stay out of the
way on pointer devices and reveal themselves on hover — but **a touch device
can never hover**, so a hover-only action is unreachable on a phone. Use the
shared `ROW_ACTION` class (`@/lib/utils`):

```tsx
import { cn, ROW_ACTION } from "@/lib/utils";

<div className="group flex items-center gap-3 px-4 py-3">
  {/* row content */}
  <DropdownMenu>
    <DropdownMenuTrigger
      render={(triggerProps) => (
        <Button variant="ghost" size="icon-sm" className={cn("shrink-0", ROW_ACTION)} {...triggerProps}>
          <MoreVertical />
          <span className="sr-only">Actions for {item.title}</span>
        </Button>
      )}
    />
    <DropdownMenuContent align="end">
      <DropdownMenuItem variant="destructive" onClick={onDelete}>
        <Trash2 />
        Delete
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
</div>
```

`ROW_ACTION` = hidden, revealed on `group-hover` / `group-focus-within`, and
**always visible when a coarse pointer exists** (`any-pointer-coarse:`).

- **Destructive row actions go behind the row menu**, not on a bare always-
  visible button next to every row — a permanent one-tap delete is too easy to
  hit while scrolling.
- **Named groups** (`group/message`, `group/col`) keep their own hover variant
  and add `any-pointer-coarse:opacity-*` themselves.
- **Inline actions on a message/card** (copy, edit, open-link hints) only need
  the pointer variant added: `group-hover/message:opacity-70 any-pointer-coarse:opacity-70`.
- A dimmed action (`opacity-60 hover:opacity-100`) is fine as-is — it is only
  *louder* on hover, never hidden.

## Table

For structured data that needs columns:

```tsx
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

<GlassPanel>
  <GlassPanelHeader title="Projects" />
  <GlassPanelContent className="p-0">
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="text-right">Due Date</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {projects.map((project) => (
          <TableRow key={project.id}>
            <TableCell className="font-medium">{project.name}</TableCell>
            <TableCell>
              <Badge variant={project.status}>{project.status}</Badge>
            </TableCell>
            <TableCell className="text-muted-foreground text-right">{project.dueDate}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  </GlassPanelContent>
</GlassPanel>;
```

### Table Rules

- **Only when columns add clarity.** If data fits in a list, use a list.
- **Max 4 columns.** If you need more, use a detail view.
- **Hover on rows:** `hover:bg-accent/60`
- **No vertical dividers.** Only horizontal separators between rows.
- **Right-align numbers.** Left-align everything else.

## Empty State

When a list has no items:

```tsx
<GlassPanel>
  <GlassPanelHeader title="Tasks" />
  <GlassPanelContent>
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <ListTodo className="text-muted-foreground/50 mb-3 h-8 w-8" />
      <p className="text-sm font-medium">No tasks yet</p>
      <p className="text-muted-foreground mt-1 text-xs">Create a task to get started</p>
      <Button variant="secondary" size="sm" className="mt-4">
        New Task
      </Button>
    </div>
  </GlassPanelContent>
</GlassPanel>
```

## Pagination

For lists with many items:

```tsx
import { Button } from "@/components/ui/button";

<GlassPanelFooter>
  <span className="text-muted-foreground text-xs">Showing 1-20 of 156</span>
  <div className="flex gap-1">
    <Button variant="ghost" size="sm" disabled>
      Previous
    </Button>
    <Button variant="ghost" size="sm">
      Next
    </Button>
  </div>
</GlassPanelFooter>;
```

- Show count and next/previous (no page numbers)
- Or use infinite scroll with a "Load more" button
- Never show 10+ page number buttons

## Rules

- **Lists inside GlassPanels.** Never floating list items.
- **Touch targets ≥ 48px.** Row height including padding.
- **Dividers between items.** `<Separator>` with horizontal padding.
- **Truncate long text.** `truncate` or `line-clamp-*`.
- **Hover states on every row.** Subtle token fill (`hover:bg-accent/60`).
- **Max 4 table columns.** More than that needs a detail view.

## Common Mistakes

| Mistake                   | Fix                                   |
| ------------------------- | ------------------------------------- |
| No hover state on rows    | Add `hover:bg-accent/60`              |
| Hover-only row action     | Use `ROW_ACTION` (`any-pointer-coarse:`) so touch can reach it |
| Rows < 48px tall          | Increase padding                      |
| No dividers between items | Add `<Separator>`                     |
| 5+ column tables          | Reduce columns, add detail view       |
| Page number pagination    | Use next/previous only                |
| No empty state            | Show friendly empty state with action |
