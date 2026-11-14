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
  <p className="text-destructive text-xs">Please enter a valid email address</p>
</div>
```

### Console Input Style

Inputs are flat: transparent background, 1px `border-input`, `rounded-lg`, orange focus ring:

```tsx
// The shadcn Input already has this:
// h-8 rounded-lg border bg-transparent border-input
// focus-visible:border-ring focus-visible:ring-ring/50
// If customization is needed, keep it flat — never bg-white/N or blur
className = "bg-transparent";
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
  <Label htmlFor="notify" className="font-normal">
    Send me notifications
  </Label>
</div>
```

## Switch

```tsx
<div className="flex items-center justify-between">
  <div className="space-y-0.5">
    <Label>Dark mode</Label>
    <p className="text-muted-foreground text-xs">Toggle dark mode on or off</p>
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
    <Button type="button" variant="ghost">
      Cancel
    </Button>
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
    <form className="space-y-6">{/* fields */}</form>
  </GlassPanelContent>
  <GlassPanelFooter>
    <Button variant="ghost">Cancel</Button>
    <Button>Save Changes</Button>
  </GlassPanelFooter>
</GlassPanel>
```

## Input Heights

| Element        | Height          | Classes        |
| -------------- | --------------- | -------------- |
| Standard input | 40px            | `h-10`         |
| Compact input  | 36px            | `h-9`          |
| Textarea       | Auto (min 80px) | `min-h-[80px]` |
| Select trigger | 40px            | `h-10`         |

## Focus States

```tsx
className =
  "focus-visible:ring-2 focus-visible:ring-accent/20 focus-visible:border-accent transition-all duration-150";
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

## Settings Grouping

A settings page is scanned, never read. Rows of one control type sit together, in the same order on every page and in every section, so a person scrolling the page learns where each kind of control turns up:

1. **Toggles** — `Switch`, `Checkbox`
2. **Choices** — `Select`, `MultiSelect`, `SegmentedControl`
3. **Values** — `Input`, `NumberRow`, `Textarea`
4. **Actions** — a row whose control is a button (Test connection, Reconnect, Regenerate)

```tsx
// what the section does, how it behaves, then what it is pointed at
<PageSection title="Search">
  <SettingsRow label="Enabled">…Switch…</SettingsRow>
  <SettingsRow label="Enabled sources">…MultiSelect…</SettingsRow>
  <SettingsRow label="Results per page">…NumberRow…</SettingsRow>
  <SettingsRow label="Connection">…Button…</SettingsRow>
</PageSection>
```

- The order is per section, meaning a `PageSection` or a divided block inside a panel. It holds when a group has one row.
- Group before dividers: two toggles around a dropdown belong in one toggle group, and the section gets a title instead of a stray divider.
- Keep the order across pages. A user who learned that switches sit at the top of a section finds them there in account settings and in admin settings alike.
- Rows in a group share one shape: label and description on the left, control on the right (`SettingsRow` in `src/components/admin/admin-settings/settings-rows.tsx`).
- A sheet that edits one thing follows the same order, with the switch that turns the object on above its name field.
- A search box or filter that narrows a list sits at the top of that list, above its rows. It is a toolbar and stays out of the stack.
- A dialog that writes data (a new memory, a task, a calendar event) follows its own field order. The grouping is for settings.

## Rules

- **Labels above inputs in forms.** No floating labels, no inline labels.
- **No required asterisks in labels.** Use `aria-required` and show "Required" in helper text if needed.
- **Consistent spacing.** `space-y-2` between label and input, `space-y-6` between fields.
- **Actions in footer.** Form submit/cancel buttons go in `GlassPanelFooter`.
- **One form per panel.** Don't split a single form across multiple panels.

## Common Mistakes

| Mistake                    | Fix                       |
| -------------------------- | ------------------------- |
| Raw `<input>` element      | Use `<Input>` from shadcn |
| Floating labels            | Labels above inputs       |
| Red input background       | Red border only           |
| No error message           | Inline error below field  |
| ALL CAPS placeholders      | Sentence case             |
| Actions inline with fields | Move to panel footer      |
