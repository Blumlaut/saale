# Saale — Agent Rules

## Project Maturity

This project is **production-ready**. There is live data that must not be lost.

### Database Migrations

See `.pi/skills/database-migrations/SKILL.md` for the full workflow, rules, and troubleshooting.

**Never touch:** `prisma.config.mjs` (handles env loading — changing it breaks deployments).

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

## Never Swallow Errors

- **Every `catch` block must log the error.** No empty `catch {}`, no `.catch(() => {})`, no `// silently fail`.
- Use `console.error("descriptive context:", err)` at minimum. The context string must identify *what* failed, not just repeat the error message.
- Fire-and-forget promises (`.catch(...)`) must still log — the error is swallowed from the caller but must appear in logs for debugging.
- The only exception is intentional early-exit guards (e.g., `if (!condition) return;`), which are not error handling.

### Examples

```ts
// ❌ BAD — error silently disappears
await fetch(url).catch(() => {});

try {
  parse(data);
} catch {
  // skip malformed
}

// ✅ GOOD — error logged with context
await fetch(url).catch((err) => {
  console.error("Failed to fetch config:", err);
});

try {
  parse(data);
} catch (err) {
  console.error("Malformed config data:", err);
}
```

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
- **The flex containment chain:** `h-full` (page) → `flex flex-col` → optional action row (`shrink-0`) → content (`flex-1 min-h-0 overflow-hidden`) → scrollable area (`flex-1 overflow-y-auto`) → footer (`shrink-0`).
- **No title/subtitle headers.** Two-line title+description rows are wasted vertical space. A page may pin at most a compact **one-line header** — title left, actions right, no subtitle (`PageToolbar`); action buttons are icon-only on mobile, label at `md:`. Pages without actions start straight at the content.

### Use the shared Page components (required)

New pages **must** be built from `src/components/layout/page.tsx` — do not hand-roll the flex chain:

- `<Page>` — root wrapper (`flex h-full min-h-0 flex-col gap-4`).
- `<PageToolbar title="...">` — compact one-line page header (title left, actions right, no subtitle); stays visible while content scrolls. Omit it entirely if the page has no actions.
- `<PageScroll>` — the ONLY scrollable content region (`min-h-0 flex-1 overflow-y-auto`).
- `<PageTabStrip>` — pinned, swipe-scrollable tab strip with hidden scrollbar (for `Tabs` pages).

```tsx
// ✅ GOOD — the pattern every page uses
<Page>
  <PageToolbar title="Tasks">
    <Button size="icon" className="h-8 w-8 md:h-9 md:w-auto md:px-3" onClick={...}>
      <Plus className="h-4 w-4" />
      <span className="hidden md:inline">New Task</span>
    </Button>
  </PageToolbar>
  <PageScroll>{/* tall content scrolls here */}</PageScroll>
</Page>

// ❌ BAD — input scrolls out of view / content clipped with no scroll
<div className="flex flex-col">
  <div>Header</div>
  <div>Messages</div>
  <div>Input bar</div>  {/* gets pushed off-screen */}
</div>
```

Tab pages: strip goes in `<PageTabStrip>`, tab content gets `className="min-h-0 flex-1 overflow-y-auto"`. Never add `w-full` to a `TabsList` (triggers squeeze and overlap). Grid items holding lists need `min-w-0` so nowrap text truncates instead of widening the page.

`e2e/mobile-overflow.spec.ts` enforces the whole contract at 375px and 320px — if a page regresses (horizontal overflow, squeezed tabs, body scroll, unreachable content), CI fails.

## Modals Must Fit Their Bounds

- **An open overlay never scrolls horizontally.** Long unbreakable values (SSH keys, tokens, URLs, IDs, hosts) must wrap (`break-all` / `whitespace-pre-wrap`) or scroll inside their *own* `overflow-x-auto` box — never widen the modal.
- **Never put a bare `grid` in an overlay.** An implicit `auto` track is sized by its items' min-content, so `grid gap-2 sm:grid-cols-2` blows out the modal; always declare the mobile track first (`grid-cols-1 gap-2 sm:grid-cols-2`).
- **`min-w-0` on the element that can be squeezed** (flex/grid item wrapping nowrap or `truncate` content), not just on an ancestor.
- `DialogContent` / `AlertDialogContent` already apply `grid-cols-1 *:min-w-0`, so a child's min-content can't stretch a modal — do not remove those classes.
- **Register every new overlay in `e2e/modal-scenarios.ts`** (a scenario, or an entry with a documented `skip` reason). `e2e/modal-overflow.spec.ts` opens each one at 375px and 320px and asserts the contract; `__tests__/overlay-coverage.test.ts` fails when an overlay isn't registered, and also fails on bare grids inside overlays.

```tsx
// ❌ BAD — nowrap value in a flex row widens the dialog
<div className="flex items-center gap-2">
  <pre className="flex-1 overflow-x-auto whitespace-nowrap">{publicKey}</pre>
</div>

// ✅ GOOD — value wraps, row can shrink
<div className="flex min-w-0 items-start gap-2">
  <pre className="min-w-0 flex-1 break-all whitespace-pre-wrap">{publicKey}</pre>
</div>
```

## Unified Glass Panels

- **All panels use liquid glass by default.** The `GlassPanel` component applies `glass-panel liquid-glass` automatically.
- **Never add `liquid-glass` manually to `GlassPanel`** — it's baked in.
- **All overlay surfaces include `liquid-glass` by default:** `DialogContent`, `AlertDialogContent`, `SheetContent`, `PopoverContent`, `DropdownMenuContent`, `SelectContent`, `TabsList`.
- **Never add `liquid-glass` manually to overlay components** — it's baked into the base UI components.
- For nested content areas inside panels, use `liquid-glass-inner` on a plain `<div>`.
- For buttons/badges/toggles, use `liquid-glass-pill` or `liquid-glass-accent`.

### Examples

```tsx
// ✅ GOOD — GlassPanel has liquid-glass automatically
<GlassPanel>
  <GlassPanelContent>Content</GlassPanelContent>
</GlassPanel>

// ✅ GOOD — remove border when needed
<GlassPanel className="border-0">
  <GlassPanelContent>Content</GlassPanelContent>
</GlassPanel>

// ❌ BAD — liquid-glass is redundant on GlassPanel
<GlassPanel className="liquid-glass border-0 bg-transparent">
  <GlassPanelContent>Content</GlassPanelContent>
</GlassPanel>

// ✅ GOOD — SheetContent has liquid-glass automatically
<SheetContent className="flex w-full flex-col p-0 sm:w-[440px]">
  {children}
</SheetContent>

// ❌ BAD — liquid-glass is redundant on SheetContent
<SheetContent className="liquid-glass flex w-full flex-col border-0 bg-transparent p-0">
  {children}
</SheetContent>
```

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

## Extract Reusable Helpers

- **Keep API routes thin.** Routes should orchestrate — authenticate, validate input, delegate to helpers, return a response. Business logic belongs in `src/lib/`, not inside route handlers.
- **Never duplicate logic.** If two routes (or a route and a background job) do the same thing (DB writes, email sends, state updates), extract it into a shared helper in `src/lib/`.
- **Prefer named helper functions over inline logic.** A `saveCompactionMessage()` in `src/lib/chat/` is better than the same Prisma call copy-pasted into three different files.
- **When adding logic to a route, ask: "will this be needed elsewhere?"** If yes (or if it's more than a trivial one-liner), extract it first.

### Examples

```ts
// ❌ BAD — DB logic duplicated inline in a route
export async function POST(request: NextRequest) {
  // ... auth, validation ...
  await prisma.chatMessage.create({
    data: { sessionId, role: "compaction", content: summary, /* ... */ },
  });
  return NextResponse.json({ ok: true });
}

// ✅ GOOD — extracted helper used by any caller
// src/lib/chat/compaction.ts
export async function saveCompactionMessage({ sessionId, summary, tokensBefore }) {
  await prisma.chatMessage.create({ data: { sessionId, role: "compaction", /* ... */ } });
}

// src/app/api/chat/sessions/[id]/compact/route.ts
export async function POST(request: NextRequest) {
  // ... auth, validation ...
  await saveCompactionMessage({ sessionId, summary, tokensBefore });
  return NextResponse.json({ ok: true });
}
```

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
