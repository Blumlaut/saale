# Typography

## Font

- **Body / UI:** `DM Sans` — loaded via `next/font/google` in `layout.tsx`. Geometric, warm, friendly, excellent at small sizes.
- **Monospace:** `Geist Mono` — code snippets only, never for UI text
- **Single typeface family** across the entire application

## Scale

| Element            | Size | Weight         | Line Height     | Tailwind Classes                       |
| ------------------ | ---- | -------------- | --------------- | -------------------------------------- |
| Page heading       | 24px | 600 (semibold) | tight (1.25)    | `text-2xl font-semibold leading-tight` |
| Section heading    | 18px | 600 (semibold) | snug (1.375)    | `text-lg font-semibold leading-snug`   |
| Card title         | 16px | 500 (medium)   | snug (1.375)    | `text-base font-medium leading-snug`   |
| Body text          | 14px | 400 (normal)   | relaxed (1.625) | `text-sm leading-relaxed`              |
| Metadata / labels  | 12px | 400 (normal)   | normal (1.5)    | `text-xs leading-normal`               |
| Overline / caption | 11px | 500 (medium)   | normal (1.5)    | `text-[11px] font-medium`              |

## Letter Spacing

- **Default:** `tracking-normal` everywhere
- **Large headings only:** `tracking-tight` (page headings, hero text)
- **Never:** `tracking-wide` or `tracking-widest` in UI text

## Text Case

| Context                                                    | Style         | Example                      |
| ---------------------------------------------------------- | ------------- | ---------------------------- |
| Headings                                                   | Title Case    | "Inbox"                      |
| Body text                                                  | Sentence case | "You have 3 unread messages" |
| Labels                                                     | Sentence case | "Search emails"              |
| Buttons                                                    | Sentence case | "Send message"               |
| Abbreviations                                              | UPPERCASE     | "API", "URL", "ID"           |
| **Never use ALL CAPS** for UI labels, headings, or buttons |

## Text Truncation

Long text must never break layout:

| Context                       | Method     | Classes           |
| ----------------------------- | ---------- | ----------------- |
| Single line (names, subjects) | Truncate   | `truncate`        |
| Two lines (preview text)      | Line clamp | `line-clamp-2`    |
| Three lines (descriptions)    | Line clamp | `line-clamp-3`    |
| Code / monospace              | Scroll     | `overflow-x-auto` |

Never allow unbounded text wrapping that pushes content out of its container.

## Font Weights

| Weight                                                        | Usage                                      |
| ------------------------------------------------------------- | ------------------------------------------ |
| 400 (normal)                                                  | Body text, labels, descriptions            |
| 500 (medium)                                                  | Card titles, button text, active nav items |
| 600 (semibold)                                                | Page headings, section headings            |
| **Never use 700 (bold)** except for emphasis within body text |

## Text Colors

| Hierarchy | Token                      | Usage                                      |
| --------- | -------------------------- | ------------------------------------------ |
| Primary   | `text-foreground`          | Headings, body text, button labels         |
| Secondary | `text-muted-foreground`    | Labels, timestamps, metadata, descriptions |
| Tertiary  | `text-muted-foreground/70` | Placeholders, disabled text, hints         |
| Link      | `text-primary` or accent   | Interactive text links                     |

## Implementation

```tsx
// Page heading
<h1 className="text-2xl font-semibold leading-tight tracking-tight">
  Dashboard
</h1>

// Section heading
<h2 className="text-lg font-semibold leading-snug">
  Recent Activity
</h2>

// Card title
<h3 className="text-base font-medium leading-snug">
  Email Subject
</h3>

// Body text
<p className="text-sm leading-relaxed text-muted-foreground">
  Description or preview text goes here.
</p>

// Metadata
<span className="text-xs text-muted-foreground">
  2 hours ago
</span>
```

## Common Mistakes

| Mistake                    | Fix                                       |
| -------------------------- | ----------------------------------------- |
| `font-bold` on headings    | Use `font-semibold`                       |
| `text-base` for body       | Use `text-sm` (14px is the body size)     |
| `uppercase` on labels      | Use sentence case                         |
| No truncation on long text | Add `truncate` or `line-clamp-*`          |
| Monospace for UI text      | Use Inter (`font-sans`)                   |
| Hardcoded font sizes       | Use Tailwind scale (`text-sm`, `text-lg`) |
