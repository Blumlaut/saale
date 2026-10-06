# Saale — Agent Rules

## Project Maturity

This project is **production-ready**. There is live data that must not be lost.

### Database Migrations

See `.pi/skills/database-migrations/SKILL.md` for the full workflow, rules, and troubleshooting.

**Never touch:** `prisma.config.mjs` (handles env loading — changing it breaks deployments).

### UI & Layout

Any UI work (pages, panels, forms, lists, modals, buttons, inputs, styling) **must** load `.pi/skills/saale-design/SKILL.md` first — it holds the full console design system plus rules, examples, and the reference files. Non-negotiable invariants:

- **Fixed app shell** — the body/viewport NEVER scrolls. Pages use `h-full flex flex-col` with internal scroll regions (`flex-1 min-h-0 overflow-y-auto`); toolbars/action rows are pinned with `shrink-0` and never scroll away. Never `h-dvh`/`h-screen`/`calc(100vh - X)` inside page components.
- **No page titles** — the nav already names the page. List pages are a single full-height panel whose first row is the toolbar (actions right, icon-only on mobile; functional context left — never a bare page name).
- **Pages are built from `src/components/layout/page.tsx`** (`Page`, `PageToolbar`, `PageScroll`, `PageTabStrip`) — never hand-roll the flex chain. No `w-full` on `TabsList`; grid items holding lists need `min-w-0`.
- **Overlays never scroll horizontally** — long unbreakable values wrap (`break-all` / `whitespace-pre-wrap`) or scroll in their *own* `overflow-x-auto` box. No bare `grid` in overlays (declare `grid-cols-1` first). Register every new overlay in `e2e/modal-scenarios.ts`.
- **`liquid-glass` is baked into `GlassPanel` and all overlay components** — never add it manually; use `liquid-glass-inner` for nested content areas, `liquid-glass-pill`/`liquid-glass-accent` for buttons/badges/toggles.
- **Chat is the one full-bleed view** — `src/app/dashboard/chat/layout.tsx` marks its root `full-bleed`, which drops the shell gutter so the view runs to the window edges on phones *and* desktop (the floating nav keeps its margin). Don't put page padding, rounded panels or `rounded-2xl` back into it.
- **Row actions must be reachable without hover** — touch devices can't hover, so use `ROW_ACTION` (`@/lib/utils`) for row menus/buttons and destructive row actions belong behind the row menu. A hover-only control is invisible on a phone.
- `e2e/mobile-overflow.spec.ts`, `e2e/modal-overflow.spec.ts`, `e2e/chat-full-bleed.spec.ts` and `__tests__/overlay-coverage.test.ts` enforce all of this at 375px and 320px — a regression fails CI.

## Investigate Before Using

- **Never assume an API, method, or type exists.** Always inspect the actual source, docs, or type declarations before writing code that depends on a library's API.
- When using a third-party package, check its `dist/`, `index.d.ts`, or source files to verify exports, signatures, and behavior.
- When debugging errors, trace them to the actual code — don't guess at fixes based on the error message alone.
- Prefer reading the docs or running a quick `node -e "import(...)"` probe over assuming how something works.

## Commits

- Every change **must** be committed before moving on.
- Commit messages: **max 50 chars**, imperative mood, descriptive (e.g. ✅ `add prisma schema for users and sessions`, ❌ `update stuff`).
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

## Never Swallow Errors

- **Every `catch` block must log the error.** No empty `catch {}`, no `.catch(() => {})`, no `// silently fail`.
- Use `console.error("descriptive context:", err)` at minimum — the context identifies *what* failed, not just the message.
- Fire-and-forget promises (`.catch(...)`) must still log.
- Intentional early-exit guards (`if (!condition) return;`) are not error handling and need no log.

```ts
// ❌ BAD — error silently disappears
await fetch(url).catch(() => {});

// ✅ GOOD — error logged with context
await fetch(url).catch((err) => {
  console.error("Failed to fetch config:", err);
});
```

## No Nested Interactive Elements

- **Never nest `<button>` inside `<button>`, `<a>` inside `<button>`, or `<button>` inside `<a>`.** Hydration errors in Next.js, invalid HTML.
- base-ui primitives (`PopoverTrigger`, `DropdownMenuTrigger`, `SheetTrigger`, `DialogTrigger`) render as `<button>` by default — **never wrap a `<Button>` inside them**; use a styled `<span>` or `<div>` instead.
- `<Link>` renders as `<a>` — never wrap a `<Button>` inside `<Link>`; use the Button's `onClick` directly.
- When in doubt, inspect the rendered DOM to verify no nested interactive elements exist.

## Mobile-First Layouts

- **All new components are mobile-first.** Use responsive Tailwind classes: `px-4 md:px-6`, `text-sm md:text-base`, `gap-3 md:gap-4`, etc.
- **Never use fixed padding larger than `px-4` without a responsive override.** If a component needs `px-6`, write `px-4 md:px-6`.
- **Grids must have a mobile fallback.** `grid-cols-1 md:grid-cols-2`, not just `grid-cols-2`.
- **Fixed widths (`w-96`, `w-72`) are forbidden** unless wrapped in an overflow container. Use `max-w-` or responsive widths instead.
- **Horizontal scrollable areas** must have `overflow-x-auto` and `-webkit-overflow-scrolling: touch`.
- When in doubt, preview at `375px` width (iPhone SE) before committing.

## User Isolation

- **Every database query must be scoped to the authenticated user.** No exceptions. Data leakage between users is a critical bug.
- **Prisma queries:** always include `userId` in `where` clauses. Never trust IDs alone — an attacker can guess or enumerate IDs from another user.
- **Raw SQL:** use `Prisma.sql` template tags (parameterized), never `$queryRawUnsafe` with string interpolation.
- **AI tools:** the `userId` is injected via closure in tool factories (`createXxxTools(userId)`). Every query inside must use this `userId`.
- **Background jobs:** use `task.userId` from the resolved task record. Never assume the job runner context implies a user.
- **Bulk updates/deletes:** include `userId` in `where` even when operating on IDs fetched earlier in the same function (defense in depth).

```ts
// ❌ BAD — ID-only filter, no user scope
await prisma.memory.updateMany({ where: { id: { in: memoryIds } }, data: { accessCount: { increment: 1 } } });

// ✅ GOOD — userId guard on every query
await prisma.memory.updateMany({ where: { id: { in: memoryIds }, userId }, data: { accessCount: { increment: 1 } } });

// ❌ BAD — prisma.$queryRawUnsafe(`SELECT * FROM Memory WHERE userId = ${userId}`)
// ✅ GOOD — prisma.$queryRaw`SELECT * FROM Memory WHERE userId = ${userId}`
```

## No Hardcoded Values

- **Never hardcode logic, configs, or environment-specific values in the code.**
- Configuration (API keys, timeouts, feature flags, URLs, thresholds) belongs in env vars, config files, or a dedicated config module — not scattered as literals.
- Don't embed conditional logic behind magic strings or numbers. Extract into named constants, enums, or config objects.
- When a value could vary by environment or user preference, parameterize it.

## Extract Reusable Helpers

- **Keep API routes thin.** Routes should orchestrate — authenticate, validate input, delegate to helpers, return a response. Business logic belongs in `src/lib/`, not inside route handlers.
- **Never duplicate logic.** If two routes (or a route and a background job) do the same thing (DB writes, email sends, state updates), extract it into a shared helper in `src/lib/`.
- **Prefer named helper functions over inline logic.** A `saveCompactionMessage()` in `src/lib/chat/` is better than the same Prisma call copy-pasted into three different files.
- **When adding logic to a route, ask: "will this be needed elsewhere?"** If yes (or if it's more than a trivial one-liner), extract it first.

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

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
