# Inputs and Forms

## Component

Always use shadcn/ui components for form elements:

```tsx
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
```

Never use raw `<input>`, `<textarea>`, or `<select>` elements.

## Text Input

### Basic

```tsx
<div className="space-y-2">
  <Label htmlFor="email">Email</Label>
  <Input id="email" type="email" placeholder="you@example.com" />
</div>
```

### With Error

```tsx
<div className="space-y-2">
  <Label htmlFor="email">Email</Label>
  <Input id="email" type="email" className="border-destructive" aria-invalid="true" />
  <p className="text-xs text-destructive">Please enter a valid email address</p>
</div>
```

### Glass Input Style

The base Input component should have a glass appearance:

```tsx
// The shadcn Input should already support this via CSS variables
// If customization is needed:
className="bg-white/30 dark:bg-white/5 border-border/50 focus:border-accent focus:ring-accent/20"
```

## Textarea

```tsx
<div className="space-y-2">
  <Label htmlFor="message">Message</Label>
  <Textarea id="message" placeholder="Type your message..." rows={4} />
</div>
```

## Select

```tsx
<div className="space-y-2">
  <Label>Priority</Label>
  <Select>
    <SelectTrigger>
      <SelectValue placeholder="Select priority" />
    </SelectTrigger>
    <SelectContent>
      <SelectItem value="low">Low</SelectItem>
      <SelectItem value="medium">Medium</SelectItem>
      <SelectItem value="high">High</SelectItem>
    </SelectContent>
  </Select>
</div>
```

## Checkbox

```tsx
<div className="flex items-center gap-2">
  <Checkbox id="notify" />
  <Label htmlFor="notify" className="font-normal">Send me notifications</Label>
</div>
```

## Switch

```tsx
<div className="flex items-center justify-between">
  <div className="space-y-0.5">
    <Label>Dark mode</Label>
    <p className="text-xs text-muted-foreground">Toggle dark mode on or off</p>
  </div>
  <Switch />
</div>
```

## Form Layout

### Vertical Form (Default)

```tsx
<form className="space-y-6">
  <div className="space-y-2">
    <Label htmlFor="name">Name</Label>
    <Input id="name" placeholder="Your name" />
  </div>
  <div className="space-y-2">
    <Label htmlFor="email">Email</Label>
    <Input id="email" type="email" placeholder="you@example.com" />
  </div>
  <div className="flex justify-end gap-2">
    <Button type="button" variant="ghost">Cancel</Button>
    <Button type="submit">Save</Button>
  </div>
</form>
```

### Inline Actions

Form actions go in the GlassPanel footer, not inline with fields:

```tsx
<GlassPanel>
  <GlassPanelHeader title="Edit Profile" />
  <GlassPanelContent>
    <form className="space-y-6">
      {/* fields */}
    </form>
  </GlassPanelContent>
  <GlassPanelFooter>
    <Button variant="ghost">Cancel</Button>
    <Button>Save Changes</Button>
  </GlassPanelFooter>
</GlassPanel>
```

## Input Heights

| Element | Height | Classes |
|---|---|---|
| Standard input | 40px | `h-10` |
| Compact input | 36px | `h-9` |
| Textarea | Auto (min 80px) | `min-h-[80px]` |
| Select trigger | 40px | `h-10` |

## Focus States

```tsx
className="focus-visible:ring-2 focus-visible:ring-accent/20 focus-visible:border-accent transition-all duration-150"
```

- Ring color: Accent at low opacity
- Border: Becomes accent color on focus
- Transition: 150ms ease-out

## Placeholder Text

- Use sentence case: "Search emails" not "SEARCH EMAILS"
- Keep under 40 characters
- Use muted color: `text-muted-foreground`

## Validation

- Show errors inline, below the field
- Error text: `text-xs text-destructive`
- Mark invalid inputs: `border-destructive`
- Use `aria-invalid="true"` for accessibility
- Never use red backgrounds on inputs (only border color change)

## Rules

- **Labels always above inputs.** No floating labels, no inline labels.
- **No required asterisks in labels.** Use `aria-required` and show "Required" in helper text if needed.
- **Consistent spacing.** `space-y-2` between label and input, `space-y-6` between fields.
- **Actions in footer.** Form submit/cancel buttons go in `GlassPanelFooter`.
- **One form per panel.** Don't split a single form across multiple panels.

## Common Mistakes

| Mistake | Fix |
|---|---|
| Raw `<input>` element | Use `<Input>` from shadcn |
| Floating labels | Labels above inputs |
| Red input background | Red border only |
| No error message | Inline error below field |
| ALL CAPS placeholders | Sentence case |
| Actions inline with fields | Move to panel footer |
