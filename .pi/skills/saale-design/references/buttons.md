# Buttons

## Component

Always use the shadcn `<Button>` component. Never use raw `<button>` elements.

```tsx
import { Button } from "@/components/ui/button";
```

## Variants

### Default (Primary)

Solid background, used for the **single primary action** per view:

```tsx
<Button>Save Changes</Button>
```

- Background: `bg-primary text-primary-foreground`
- Hover: Slight brightness shift
- Corner radius: `rounded-full`
- Max one primary button per view

### Secondary

Glass-style button, the default for most actions:

```tsx
<Button variant="secondary">Cancel</Button>
```

- Background: `bg-secondary text-secondary-foreground`
- Border: Subtle
- Use for: Secondary actions, toolbar buttons, card header actions

### Ghost

No border, hover-only background. Used in dense areas:

```tsx
<Button variant="ghost" size="sm">
  Edit
</Button>
```

- Background: Transparent, hover shows subtle tint
- Use for: Inline actions, table row actions, navigation links within panels

### Destructive

Red text only (no red background):

```tsx
<Button variant="destructive">Delete</Button>
```

- Always confirm in a `<Dialog>` before executing
- Never use red backgrounds on buttons

### Outline

Border-only, for tertiary actions:

```tsx
<Button variant="outline">Learn More</Button>
```

- Use for: Links that look like buttons, optional actions

### Link

Text-only, for inline actions:

```tsx
<Button variant="link">View all</Button>
```

- Use for: "View all" links, inline navigation

## Sizes

| Size      | Height        | Padding   | Usage                         |
| --------- | ------------- | --------- | ----------------------------- |
| `default` | 40px (`h-10`) | Standard  | Form actions, primary buttons |
| `sm`      | 36px (`h-9`)  | Compact   | Card header actions, toolbars |
| `lg`      | 44px (`h-11`) | Generous  | Hero actions, empty states    |
| `icon`    | Square        | Icon-only | Theme toggle, close buttons   |

## Corner Radius

All buttons use `rounded-full`. Never use square or slightly rounded buttons.

If the base Button component doesn't use `rounded-full`, override in the component or via a wrapper:

```tsx
<Button className="rounded-full">Rounded</Button>
```

## Icon Buttons

When a button contains only an icon:

```tsx
import { Trash2 } from "lucide-react";

<Button variant="ghost" size="icon" aria-label="Delete">
  <Trash2 className="h-4 w-4" />
</Button>;
```

- Always include `aria-label` for accessibility
- Icon size: `h-4 w-4` (16px)
- Touch target: Minimum 40px (handled by `size="icon"`)

## Icon + Text Buttons

```tsx
import { Plus } from "lucide-react";

<Button>
  <Plus className="mr-2 h-4 w-4" />
  New Task
</Button>;
```

- Icon on the left, text on the right
- Gap: `mr-2` (8px) between icon and text
- Icon size: `h-4 w-4`

## Loading State

```tsx
import { Spinner } from "@/components/ui/spinner";

<Button disabled>
  <Spinner className="mr-2 h-4 w-4" />
  Saving...
</Button>;
```

- Always `disabled` while loading
- Show a spinner icon, not a text-only loading state

## Rules

- **Max one primary button per view.** Everything else is secondary, ghost, or outline.
- **Sentence case labels.** "Save changes" not "SAVE CHANGES" or "Save Changes".
- **Verbs, not nouns.** "Send message" not "Sending" or "Message".
- **No full-width buttons** except in mobile views or empty states.
- **Always provide feedback.** Loading state, success toast, or error message.

## Common Mistakes

| Mistake                       | Fix                                     |
| ----------------------------- | --------------------------------------- |
| Multiple primary buttons      | Make extras `variant="secondary"`       |
| Square buttons                | Use `rounded-full`                      |
| ALL CAPS labels               | Use sentence case                       |
| `<button>` raw element        | Use `<Button>` from shadcn              |
| Red background on delete      | Use `variant="destructive"` (text only) |
| No aria-label on icon buttons | Add descriptive `aria-label`            |
