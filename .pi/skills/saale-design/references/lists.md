# Lists and Tables

## Component

Use shadcn/ui components for list elements:

```tsx
import { Separator } from "@/components/ui/separator";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
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
            className="flex items-center gap-3 px-4 py-3 hover:bg-white/20 dark:hover:bg-white/5 transition-colors duration-150"
          >
            <Avatar>
              <AvatarFallback>{email.sender[0]}</AvatarFallback>
            </Avatar>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">{email.subject}</p>
              <p className="text-xs text-muted-foreground truncate">{email.preview}</p>
            </div>
            <span className="text-xs text-muted-foreground shrink-0">{email.time}</span>
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
- **Hover state:** `hover:bg-white/20 dark:hover:bg-white/5`
- **Transition:** `transition-colors duration-150`
- **Dividers:** `<Separator className="px-4" />` between rows (not on first/last)
- **Truncation:** `truncate` on text that might be long
- **Gap:** `gap-3` (12px) between row elements

## Dense List

For lists where more items visible is important:

```tsx
className="flex items-center gap-2 px-4 py-2 hover:bg-white/20 dark:hover:bg-white/5"
```

- Min height: 40px
- Smaller text: `text-xs` for secondary info
- Use for: Settings lists, navigation items

## Selected / Active State

```tsx
className={cn(
  "flex items-center gap-3 px-4 py-3 transition-colors duration-150 cursor-pointer",
  isActive
    ? "bg-white/10 dark:bg-white/5 border-l-2 border-accent"
    : "hover:bg-white/20 dark:hover:bg-white/5 border-l-2 border-transparent"
)}
```

- Accent left border for active item
- Subtle background tint for active state
- No color shift on hover (just brightness)

## Table

For structured data that needs columns:

```tsx
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

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
              <Badge variant={project.status}>
                {project.status}
              </Badge>
            </TableCell>
            <TableCell className="text-right text-muted-foreground">
              {project.dueDate}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  </GlassPanelContent>
</GlassPanel>
```

### Table Rules

- **Only when columns add clarity.** If data fits in a list, use a list.
- **Max 4 columns.** If you need more, use a detail view.
- **Hover on rows:** `hover:bg-white/10 dark:hover:bg-white/5`
- **No vertical dividers.** Only horizontal separators between rows.
- **Right-align numbers.** Left-align everything else.

## Empty State

When a list has no items:

```tsx
<GlassPanel>
  <GlassPanelHeader title="Tasks" />
  <GlassPanelContent>
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <ListTodo className="h-8 w-8 text-muted-foreground/50 mb-3" />
      <p className="text-sm font-medium">No tasks yet</p>
      <p className="text-xs text-muted-foreground mt-1">Create a task to get started</p>
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
  <span className="text-xs text-muted-foreground">Showing 1-20 of 156</span>
  <div className="flex gap-1">
    <Button variant="ghost" size="sm" disabled>Previous</Button>
    <Button variant="ghost" size="sm">Next</Button>
  </div>
</GlassPanelFooter>
```

- Show count and next/previous (no page numbers)
- Or use infinite scroll with a "Load more" button
- Never show 10+ page number buttons

## Rules

- **Lists inside GlassPanels.** Never floating list items.
- **Touch targets ≥ 48px.** Row height including padding.
- **Dividers between items.** `<Separator>` with horizontal padding.
- **Truncate long text.** `truncate` or `line-clamp-*`.
- **Hover states on every row.** Subtle glass highlight.
- **Max 4 table columns.** More than that needs a detail view.

## Common Mistakes

| Mistake | Fix |
|---|---|
| No hover state on rows | Add `hover:bg-white/20` |
| Rows < 48px tall | Increase padding |
| No dividers between items | Add `<Separator>` |
| 5+ column tables | Reduce columns, add detail view |
| Page number pagination | Use next/previous only |
| No empty state | Show friendly empty state with action |
