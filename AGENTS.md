# Saale — Agent Rules

## Project Maturity

This project is in its early stages. Heavy reworks and structural changes are expected and encouraged.

- **Do not aim for backwards compatibility.** There is no legacy code worth preserving.
- Feel free to refactor, rename, move, or delete code freely if it improves the design.
- If something feels wrong or could be done better, do it better — don't carry forward bad decisions "to be safe."
- Breaking changes are the default, not an exception.

## Investigate Before Using

- **Never assume an API, method, or type exists.** Always inspect the actual source, docs, or type declarations before writing code that depends on a library's API.
- When using a third-party package, check its `dist/`, `index.d.ts`, or source files to verify exports, signatures, and behavior.
- When debugging errors, trace them to the actual code — don't guess at fixes based on the error message alone.
- Prefer reading the docs or running a quick `node -e "import(...)"` probe over assuming how something works.

## Commits

- Every change **must** be committed before moving on.
- Commit messages: **max 50 chars**, imperative mood, descriptive.
  - ✅ `add prisma schema for users and sessions`
  - ✅ `fix auth redirect loop on login`
  - ❌ `update stuff`
  - ❌ `fix bug in the authentication module that was causing issues`
- Group related changes into a single commit. No atomic-one-line commits.
- Run `npm run check` (lint + typecheck + format + tests) **before committing**. Nothing lands broken.

## Testing

- Write **meaningful tests** that verify real behaviour with multiple inputs producing expected outputs.
- No trivial tests (`1 + 1 = 2`, empty renders, etc.).
- Test actual behaviour: API responses, auth flows, tool execution, email parsing, task scheduling, edge cases.
- Every new feature or non-trivial change needs at least one test covering the happy path and one edge case.
- Tests must pass before committing. If a test fails, fix the code or the test — don't skip it.

## Code Style

- TypeScript strict mode. No `any`, no `@ts-ignore` without a comment explaining why.
- Prefer `zod` for runtime validation, `TypeBox` for Pi tool schemas.
- Server components by default, `"use client"` only when needed.
- Use `@/` import alias. No relative imports reaching up more than 2 levels.
- Error boundaries around user-facing components.

## No Nested Interactive Elements

- **Never nest `<button>` inside `<button>`, `<a>` inside `<button>`, or `<button>` inside `<a>`.** This causes hydration errors in Next.js and is invalid HTML.
- base-ui primitives (`PopoverTrigger`, `DropdownMenuTrigger`, `SheetTrigger`, `DialogTrigger`) render as `<button>` by default. **Never wrap a `<Button>` component inside them** — use a styled `<span>` or `<div>` instead.
- `<Link>` renders as `<a>`. Never wrap a `<Button>` inside `<Link>` — use the Button's `onClick` directly instead.
- When in doubt, inspect the rendered DOM (DevTools) to verify no nested interactive elements exist.

### Examples

```tsx
// ❌ BAD — PopoverTrigger renders as <button>, Button also renders as <button>
<PopoverTrigger>
  <Button>Open</Button>
</PopoverTrigger>

// ✅ GOOD — use a styled <span> inside triggers
<PopoverTrigger>
  <span className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded hover:bg-white/10">
    Open
  </span>
</PopoverTrigger>

// ❌ BAD — <Link> renders as <a>, <Button> as <button>
<Link href="/path">
  <Button>Go</Button>
</Link>

// ✅ GOOD — use Button onClick directly
<Button onClick={() => router.push("/path")}>Go</Button>
```

## Mobile-First Layouts

- **All new components are mobile-first.** Use responsive Tailwind classes: `px-4 md:px-6`, `text-sm md:text-base`, `gap-3 md:gap-4`, etc.
- **Never use fixed padding larger than `px-4` without a responsive override.** If a component needs `px-6`, write `px-4 md:px-6`.
- **Grids must have a mobile fallback.** `grid-cols-1 md:grid-cols-2`, not just `grid-cols-2`.
- **Fixed widths (`w-96`, `w-72`) are forbidden** unless wrapped in an overflow container. Use `max-w-` or responsive widths instead.
- **Height calculations must account for mobile nav.** Use `calc(100vh - X)` values that differ between `md:` and below.
- **Horizontal scrollable areas** must have `overflow-x-auto` and `-webkit-overflow-scrolling: touch`.
- When in doubt, preview at `375px` width (iPhone SE) before committing.

## No Hardcoded Values

- **Never hardcode logic, configs, or environment-specific values in the code.**
- Configuration (API keys, timeouts, feature flags, URLs, thresholds) belongs in env vars, config files, or a dedicated config module — not scattered as literals.
- Don't embed conditional logic behind magic strings or numbers. Extract into named constants, enums, or config objects.
- When a value could vary by environment or user preference, parameterize it.

## Architecture

- `src/app/` — Next.js routes and layouts
- `src/components/` — UI components (shadcn/ui in `ui/`, app components by feature)
- `src/lib/` — Business logic (pi, mail, tasks, auth)
- `src/hooks/` — React hooks
- `src/types/` — Shared TypeScript types
- `src/server/` — Server-only code (API routes, DB access)
- `prisma/` — Database schema and migrations
- `__tests__/` — Unit and integration tests
- `e2e/` — Playwright end-to-end tests

## Docker

- `docker compose up` starts everything (app + postgres + redis) with hot reload.
- `docker compose build --target production` for production image.
