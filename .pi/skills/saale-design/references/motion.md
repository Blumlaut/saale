# Motion

## Principles

1. **Subtle and purposeful.** Animations guide attention, they don't entertain.
2. **Fast.** Nothing takes more than 200ms except page transitions.
3. **Natural.** Ease-out for appearing, ease-in for disappearing. Never linear.
4. **No bounce.** No overshoot, no spring physics, no elastic effects.

## Duration Scale

| Action             | Duration | Easing   | Classes                                |
| ------------------ | -------- | -------- | -------------------------------------- |
| Hover state change | 150ms    | ease     | `transition-all duration-150 ease`     |
| Focus ring appear  | 150ms    | ease-out | `transition-all duration-150 ease-out` |
| Panel open/close   | 200ms    | ease-out | `transition-all duration-200 ease-out` |
| Dialog appear      | 200ms    | ease-out | `transition-all duration-200 ease-out` |
| List item hover    | 150ms    | ease     | `transition-colors duration-150`       |
| Page navigation    | Instant  | —        | (no animation)                         |

## Patterns

### Panel Appear

When a panel mounts or becomes visible:

```tsx
className = "animate-in fade-in slide-in-from-bottom-2 duration-200";
```

### Hover States

Subtle brightness or background shift:

```tsx
className = "hover:bg-white/20 dark:hover:bg-white/5 transition-colors duration-150";
```

### Focus Rings

```tsx
className =
  "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 transition-all duration-150";
```

### Dialog / Modal

```tsx
// Dialog content
className = "animate-in fade-in zoom-in-95 duration-200";

// Dialog overlay
className = "animate-in fade-in duration-150";
```

### List Items

```tsx
// Hover highlight
className = "hover:bg-white/20 dark:hover:bg-white/5 transition-colors duration-150";

// Selected state
className = "bg-white/10 dark:bg-white/5 transition-colors duration-150";
```

### Loading States

Use skeleton screens, never spinners:

```tsx
import { Skeleton } from "@/components/ui/skeleton";

function LoadingState() {
  return (
    <div className="space-y-3">
      <Skeleton className="h-4 w-3/4 rounded-lg" />
      <Skeleton className="h-4 w-1/2 rounded-lg" />
      <Skeleton className="h-4 w-2/3 rounded-lg" />
    </div>
  );
}
```

Skeletons should use the glass styling:

```tsx
// In globals.css or component
.skeleton {
  background: linear-gradient(
    90deg,
    rgba(255, 255, 255, 0.1) 25%,
    rgba(255, 255, 255, 0.2) 50%,
    rgba(255, 255, 255, 0.1) 75%
  );
  background-size: 200% 100%;
  animation: shimmer 1.5s infinite;
}

.dark .skeleton {
  background: linear-gradient(
    90deg,
    rgba(255, 255, 255, 0.05) 25%,
    rgba(255, 255, 255, 0.1) 50%,
    rgba(255, 255, 255, 0.05) 75%
  );
}
```

## Reduced Motion

Always respect `prefers-reduced-motion`:

```css
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```

Add this to `globals.css`. When reduced motion is preferred, all transitions become instant.

## What To Avoid

| Anti-pattern               | Why               | Alternative                       |
| -------------------------- | ----------------- | --------------------------------- |
| Bounce / spring easing     | Playful, not calm | `ease-out`                        |
| Linear transitions         | Robotic           | `ease` or `ease-out`              |
| Duration > 300ms           | Feels slow        | Max 200ms                         |
| Page transition animations | Disorienting      | Instant navigation                |
| Animated backgrounds       | Distracting       | Static gradient                   |
| Spinner for loading        | Gives no context  | Skeleton screens                  |
| Slide-in from off-screen   | Overused          | `slide-in-from-bottom-2` (subtle) |
| Scale on hover (> 1.05)    | Exaggerated       | Subtle brightness shift           |

## Tailwind Animation Utilities

Prefer Tailwind's built-in animation utilities over custom CSS:

- `animate-in` — Enter animation
- `fade-in` — Fade from transparent
- `zoom-in-95` — Scale from 95%
- `slide-in-from-bottom-2` — Slide up 8px
- `slide-in-from-top-2` — Slide down 8px
- `duration-150` / `duration-200` — Timing
- `ease-out` / `ease-in` / `ease` — Easing

Install via: `npx shadcn@latest add animation` (if not already available via `tw-animate-css`)
