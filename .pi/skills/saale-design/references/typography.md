# Typography

## Fonts

- **UI / body:** `Inter` — loaded via `next/font/google` in `layout.tsx` (`--font-sans`). Neutral, console-appropriate, excellent at small sizes.
- **Code:** `Geist Mono` (`--font-mono`) — code snippets, commands, file paths, logs and tool output. Mono is for code only.
- Two families, strict split: Inter for words, Geist Mono for code.

## Scale

| Element            | Size | Weight         | Line Height     | Tailwind Classes                       |
| ------------------ | ---- | -------------- | --------------- | -------------------------------------- |
| Page heading       | 24px | 600 (semibold) | tight (1.25)    | `text-2xl font-semibold leading-tight` |
| Section heading    | 18px | 600 (semibold) | snug (1.375)    | `text-lg font-semibold leading-snug`   |
| Card title         | 16px | 500 (medium)   | snug (1.375)    | `text-base font-medium leading-snug`   |
| Body text          | 14px | 400 (normal)   | relaxed (1.625) | `text-sm leading-relaxed`              |
| Metadata / labels  | 12px | 400 (normal)   | normal (1.5)    | `text-xs leading-normal`               |
| Console micro-label | 10px | 600 (semibold) | normal          | `.console-label` (10px, 0.18em tracking, uppercase, muted) |

The base font scales with the viewport: `font-size: clamp(14px, 1.15vw + 0.25rem, 17px)` on `html` — don't override it.

## Console Micro-Labels

The `.console-label` class is the signature of the console language:

```tsx
<span className="console-label">Saale 2026.10.0</span>
<span className="console-label">Models</span>
```

- Small caps, wide tracking (`0.18em`), semibold, muted color
- Use for: panel section labels, footer version blocks, status lines, metadata groupings
- Pair with the orange tick where a "live" feel is wanted (see the sidebar footer: `console-label` + a short `h-0.5 w-6 bg-primary` line)
- Do NOT use for headings, body text, or button labels

## Letter Spacing

- **Default:** `tracking-normal` everywhere
- **Page headings:** `tracking-tight`
- **Console micro-labels:** `0.18em` via `.console-label` (the only place wide tracking is allowed)
- **Never:** `tracking-wide`/`tracking-widest` on other text

## Text Case

| Context | Style | Example |
|---------|-------|---------|
| Headings | Sentence case | "Chat" |
| Body text | Sentence case | "You have 3 unread messages" |
| Labels / buttons | Sentence case | "Search emails", "New Task" |
| Console micro-labels | UPPERCASE (via `.console-label`) | "MODELS", "Saale 2026.10.0" |
| Abbreviations in body | UPPERCASE | "API", "URL", "ID" |
| **Never** | ALL CAPS on headings/buttons/body |

## Text Truncation

Long text must never break layout:

| Context | Method | Classes |
|---------|--------|---------|
| Single line (names, subjects) | Truncate | `truncate` |
| Two lines (preview text) | Line clamp | `line-clamp-2` |
| Three lines (descriptions) | Line clamp | `line-clamp-3` |
| Code / monospace | Scroll | `overflow-x-auto` |

## Font Weights

| Weight | Usage |
|--------|-------|
| 400 | Body text, labels, descriptions |
| 500 | Card titles, button text, active nav items |
| 600 | Page headings, section headings, console micro-labels |
| 700+ | Never (except inline emphasis) |

## Text Colors

| Hierarchy | Token | Usage |
|-----------|-------|-------|
| Primary | `text-foreground` | Headings, body, button labels |
| Secondary | `text-muted-foreground` | Labels, timestamps, metadata |
| Tertiary | `text-muted-foreground/70` | Placeholders, disabled, hints |
| Action | `text-primary` | Interactive links (orange) |

## Code Text (Geist Mono)

Mono marks text a machine produced or will consume: a snippet, a command, a path, a log line. An ID, a timestamp, a version or a count is a word like any other and stays Inter.

```tsx
<code className="font-mono text-xs">npm run check</code>
<span className="font-mono text-xs text-muted-foreground">.pi/skills/saale-design</span>
```

Code text is always ≤ `text-xs` and muted unless it is the thing being read.

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| `font-bold` on headings | Use `font-semibold` |
| `text-base` for body | Use `text-sm` |
| Uppercase labels without `.console-label` | Use sentence case, or the micro-label class |
| Monospace for sentences/buttons | Inter (`font-sans`) for words |
| Mono for an ID, timestamp or count | Inter, like any other word |
| No truncation on long text | `truncate` or `line-clamp-*` |
| Hardcoded font sizes | Tailwind scale |
