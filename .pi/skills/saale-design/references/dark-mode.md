# Dark Mode

## Rules

1. **Every component supports dark mode.** No exceptions.
2. **System preference is the default.** Use `prefers-color-scheme` as the initial value.
3. **User choice overrides system.** Stored in `localStorage`, persists across sessions.
4. **No flash of wrong theme.** Theme is applied before the first render.
5. **Both modes are equally polished.** Dark mode is not an afterthought.

## Implementation

### Theme Provider

Use `next-themes` for theme management:

```bash
npm install next-themes
```

```tsx
// src/providers/theme-provider.tsx
"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <NextThemesProvider
      attribute="class"      // adds .dark to <html>
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange={false}
    >
      {children}
    </NextThemesProvider>
  );
}
```

Wrap the app in `layout.tsx`:

```tsx
import { ThemeProvider } from "@/providers/theme-provider";

export default function RootLayout({ children }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={inter.className}>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
```

### Theme Toggle

```tsx
"use client";

import { useTheme } from "next-themes";
import { Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={() => setTheme(theme === "light" ? "dark" : "light")}
    >
      <Sun className="h-4 w-4 dark:hidden" />
      <Moon className="hidden dark:h-4 dark:w-4" />
    </Button>
  );
}
```

## CSS Custom Properties

All colors use CSS custom properties defined in `globals.css`:

```css
:root {
  --background: oklch(0.985 0.005 250);
  --foreground: oklch(0.145 0 0);
  /* ... all light mode tokens ... */
}

.dark {
  --background: oklch(0.145 0.015 250);
  --foreground: oklch(0.985 0 0);
  /* ... all dark mode tokens ... */
}
```

Tailwind maps these via `@theme inline`:

```css
@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  /* ... */
}
```

Use Tailwind utilities, never hardcoded values:

```tsx
// Correct
className="bg-background text-foreground border-border"

// Wrong
className="bg-white text-black border-gray-200"
```

## Glass in Dark Mode

Dark mode glass uses `bg-white/5` (not `bg-black/50`):

```tsx
// Light mode: frosted white glass
// Dark mode: barely-tinted glass (like looking through dark window)
className="bg-white/60 dark:bg-white/5 backdrop-blur-xl border border-white/20 dark:border-white/10"
```

The dark mode glass should feel like looking through tinted glass, not a dark box.

## Contrast Verification

| Element | Light Mode Contrast | Dark Mode Contrast |
|---|---|---|
| Primary text on background | > 12:1 | > 12:1 |
| Secondary text on background | > 4.5:1 | > 4.5:1 |
| Border on background | > 3:1 | > 3:1 |
| Glass text on glass | > 10:1 | > 10:1 |

Test every component in both modes. If it reads well in light mode but not dark (or vice versa), adjust the token — don't add a component-specific override.

## Transition Between Modes

When the user toggles themes, apply a smooth transition:

```css
/* In globals.css */
*,
*::before,
*::after {
  transition: background-color 0.2s ease, border-color 0.2s ease, color 0.2s ease;
}

/* Exclude animations from transition */
.animate-in,
.transition-none {
  transition: none !important;
}
```

This ensures colors crossfade smoothly without affecting intentional animations.

## Testing Checklist

- [ ] Every component tested in both light and dark mode
- [ ] Glass panels look correct in both modes (transparency + blur)
- [ ] Text contrast meets WCAG AA in both modes
- [ ] Borders and dividers visible in both modes
- [ ] Icons and SVGs use `currentColor` or explicit dark variants
- [ ] No hardcoded hex/rgb values in components
- [ ] Theme toggle works and persists
- [ ] No flash of wrong theme on page load
- [ ] `suppressHydrationWarning` on `<html>` tag
