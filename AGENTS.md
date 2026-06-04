# Saale — Agent Rules

## Project Maturity

This project is **production-ready**. There is live data that must not be lost.

- **All schema changes must go through migrations.** Use `npm run db:migrate` (`prisma migrate dev`) — never `prisma db push` or `db:push` with `--accept-data-loss`.
- Migration files are version-controlled and represent the authoritative history of schema changes. Never edit or delete existing migration files.
- When a migration is needed:
  1. Edit `prisma/schema.prisma` with the desired changes.
  2. Run `npm run db:migrate` — this generates a new migration SQL file.
  3. Review the generated SQL before applying. If it looks wrong, revert the schema change and fix it.
  4. Commit both the schema change and the migration file together.
- **Destructive changes** (dropping columns, renaming tables, changing column types with data loss) require explicit thought:
  - If a column is needed at runtime during deployment, split the migration into steps (e.g., add new column → backfill data → drop old column in a later migration).
  - Never drop a column that still has data you need without a data migration step.
- Refactoring application code is fine, but always consider the impact on existing data and running instances.
- If a schema change feels risky, discuss it — don't rush it.

### Examples

```bash
# ✅ GOOD — creates a tracked migration
npm run db:migrate

# ❌ BAD — silently alters production schema, can drop data
npx prisma db push --accept-data-loss

# ❌ BAD — editing a migration after it has been applied
# (this silently diverges the migration history from reality)
```

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
- **Horizontal scrollable areas** must have `overflow-x-auto` and `-webkit-overflow-scrolling: touch`.
- When in doubt, preview at `375px` width (iPhone SE) before committing.

## No External Scroll (App Shell)

- **The dashboard is a fixed-height app shell** (`h-dvh overflow-hidden`). The body/viewport NEVER scrolls.
- **All scrolling is internal to panels.** Pages use `h-full flex flex-col` with `flex-1 min-h-0 overflow-y-auto` on the scrollable region.
- **Interactive elements (input bars, toolbars, action buttons) must always be visible.** Pin them with `shrink-0` in a flex column — never let them scroll out of view.
- **Never use `h-dvh`, `h-screen`, or `calc(100vh - X)` inside page components.** The dashboard layout handles viewport sizing; pages use `h-full` to fill their allocated space.
- **The flex containment chain:** `h-full` (page) → `flex flex-col` → header (`shrink-0`) → content (`flex-1 min-h-0 overflow-hidden`) → scrollable area (`flex-1 overflow-y-auto`) → footer (`shrink-0`).

### Pattern

```tsx
// ✅ GOOD — input always visible, messages scroll internally
<div className="flex h-full flex-col">
  <div className="shrink-0">Header</div>
  <div className="min-h-0 flex-1 overflow-y-auto">Messages</div>
  <div className="shrink-0">Input bar</div>
</div>

// ❌ BAD — input scrolls out of view
<div className="flex flex-col">
  <div>Header</div>
  <div>Messages</div>
  <div>Input bar</div>  {/* gets pushed off-screen */}
</div>```

## User Isolation

- **Every database query must be scoped to the authenticated user.** No exceptions.
- All API routes, AI tools, and background jobs operate on behalf of a specific user. Data leakage between users is a critical bug.
- **Prisma queries:** always include `userId` in `where` clauses. Never trust IDs alone — an attacker can guess or enumerate IDs from another user.
- **Raw SQL:** use `Prisma.sql` template tags (parameterized), never `$queryRawUnsafe` with string interpolation.
- **AI tools:** the `userId` is injected via closure in tool factories (`createXxxTools(userId)`). Every query inside must use this `userId`.
- **Background jobs:** use `task.userId` from the resolved task record. Never assume the job runner context implies a user.
- **Bulk updates/deletes:** include `userId` in the `where` clause even when operating on IDs fetched earlier in the same function (defense in depth).

### Examples

```ts
// ❌ BAD — ID-only filter, no user scope
await prisma.memory.updateMany({
  where: { id: { in: memoryIds } },
  data: { accessCount: { increment: 1 } },
});

// ✅ GOOD — userId guard on every query
await prisma.memory.updateMany({
  where: { id: { in: memoryIds }, userId },
  data: { accessCount: { increment: 1 } },
});

// ❌ BAD — raw SQL with string interpolation
prisma.$queryRawUnsafe(`SELECT * FROM Memory WHERE userId = ${userId}`);

// ✅ GOOD — parameterized via Prisma.sql
prisma.$queryRaw`
  SELECT * FROM Memory WHERE userId = ${userId}
`;
```

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
