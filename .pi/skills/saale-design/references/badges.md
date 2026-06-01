# Badges and Tags

## Component

Always use the shadcn `<Badge>` component:

```tsx
import { Badge } from "@/components/ui/badge";
```

## Variants

### Default (Neutral)

For categories, labels, non-status tags:

```tsx
<Badge>Work</Badge>
<Badge variant="secondary">Personal</Badge>
```

### Status Badges

Semantic colors as tints on glass backgrounds:

```tsx
// Completed
<Badge className="bg-green-500/10 text-green-600 dark:bg-green-400/10 dark:text-green-400">
  Completed
</Badge>

// Pending
<Badge className="bg-amber-500/10 text-amber-600 dark:bg-amber-400/10 dark:text-amber-400">
  Pending
</Badge>

// Overdue / Error
<Badge className="bg-red-500/10 text-red-600 dark:bg-red-400/10 dark:text-red-400">
  Overdue
</Badge>

// In Progress
<Badge className="bg-blue-500/10 text-blue-600 dark:bg-blue-400/10 dark:text-blue-400">
  In Progress
</Badge>
```

## Style Rules

- **Shape:** `rounded-full` (pill-shaped)
- **Text size:** `text-xs`
- **Background:** Tinted glass (color at 10% opacity)
- **Text color:** Semantic color (not white, not black)
- **Padding:** Default Badge padding (compact)

## Usage Patterns

### In a List Row

```tsx
<div className="flex items-center gap-3 px-4 py-3">
  <div className="min-w-0 flex-1">
    <p className="truncate text-sm font-medium">Redesign homepage</p>
  </div>
  <Badge className="shrink-0 bg-amber-500/10 text-amber-600 dark:bg-amber-400/10 dark:text-amber-400">
    Pending
  </Badge>
</div>
```

### As a Filter

```tsx
<div className="flex flex-wrap gap-2">
  <Badge variant="secondary" className="hover:bg-secondary/80 cursor-pointer">
    All
  </Badge>
  <Badge className="cursor-pointer bg-blue-500/10 text-blue-600 dark:bg-blue-400/10 dark:text-blue-400">
    In Progress
  </Badge>
  <Badge className="cursor-pointer bg-green-500/10 text-green-600 dark:bg-green-400/10 dark:text-green-400">
    Completed
  </Badge>
</div>
```

### Count Badge

```tsx
<Badge variant="secondary" className="rounded-full">
  3
</Badge>
```

- Use for: Unread counts, notification counts
- Position: After the label or in the nav item

## Rules

- **Semantic colors only for status.** Categories use neutral variants.
- **Pill-shaped always.** `rounded-full`, never square.
- **Small text.** `text-xs` on all badges.
- **Tinted backgrounds.** Color at 10% opacity, never solid.
- **Max 2-3 badges per row.** More than that clutters the UI.
- **No rainbow badges.** Stick to the semantic color palette.

## Common Mistakes

| Mistake                    | Fix                                    |
| -------------------------- | -------------------------------------- |
| Solid color background     | Use 10% opacity tint                   |
| Square badges              | Use `rounded-full`                     |
| Large badge text           | Use `text-xs`                          |
| Rainbow status colors      | Use muted semantic palette             |
| More than 3 badges per row | Prioritize, move extras to detail view |
| Badge for non-status label | Use `variant="secondary"`              |
