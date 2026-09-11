# Buttons

## Component

Always use the shadcn `<Button>` component. Never use raw `<button>` elements.

```tsx
import { Button } from "@/components/ui/button";
```

## Shape

Buttons are **rectangular, `rounded-lg` (12px)** — the console control shape. The old `rounded-full` pill is gone. The base `<Button>` already uses `rounded-lg`; do not override it to a pill. (`xs` buttons keep a smaller radius via the size variant.)

## Variants

### Default (Primary)

Solid orange. The **single primary action** per view:

```tsx
<Button>New Task</Button>
```

- `bg-primary text-primary-foreground` (orange with dark text in both modes)
- Hover: `hover:bg-primary/90`
- Max one primary button per view

### Secondary

Flat neutral fill with a subtle border — the default for most actions:

```tsx
<Button variant="secondary">Cancel</Button>
```

- `bg-secondary text-secondary-foreground border-border/50`
- Use for: secondary actions, toolbar buttons, card header actions

### Ghost

No border, hover-only neutral fill. Dense areas:

```tsx
<Button variant="ghost" size="sm">Edit</Button>
```

- `hover:bg-muted`
- Use for: inline actions, table row actions, nav within panels

### Outline

Border-only, for tertiary actions:

```tsx
<Button variant="outline">Learn More</Button>
```

- `border-border bg-background hover:bg-muted`

### Destructive

Red **tint**, not a red slab:

```tsx
<Button variant="destructive">Delete</Button>
```

- `bg-destructive/10 text-destructive hover:bg-destructive/20`
- Always confirm in a `<Dialog>` before executing

### Link

Text-only inline action:

```tsx
<Button variant="link">View all</Button>
```

## Sizes

| Size | Height | Usage |
|------|--------|-------|
| `default` | 40px (`h-10`) | Form actions, primary buttons |
| `sm` | 36px (`h-9`) | Card header actions, toolbars |
| `lg` | 44px (`h-11`) | Hero actions, empty states |
| `icon` | 40px square | Theme toggle, close buttons |

## Icon + Text

```tsx
import { Plus } from "lucide-react";

<Button>
  <Plus /> New Task
</Button>;
```

- Icon renders before text at 16px (base handles `[&_svg]:size-4`)
- Gap is handled by the base (`gap-2`/`gap-3` per size) — don't add `mr-2`

## Loading State

```tsx
<Button disabled>
  <Spinner className="h-4 w-4" /> Saving...
</Button>;
```

- Always `disabled` while loading; spinner, not text-only

## Rules

- **Max one primary button per view.** Everything else is secondary, ghost, or outline.
- **Sentence case labels.** "Save changes" not "SAVE CHANGES".
- **Verbs, not nouns.** "Send message" not "Sending".
- **No full-width buttons** except in mobile views or empty states.
- **Always provide feedback.** Loading state, success toast, or error message.
- Icon buttons need `aria-label`.

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Pill buttons (`rounded-full`) | `rounded-lg` — the base already does this, don't re-add the pill |
| Multiple primary buttons | Make extras `variant="secondary"` |
| ALL CAPS labels | Sentence case |
| Raw `<button>` | `<Button>` from shadcn |
| Solid red delete button | `variant="destructive"` (red tint) |
| White-overlay hover (`bg-white/20`) | `hover:bg-muted` / `hover:bg-accent/60` |
