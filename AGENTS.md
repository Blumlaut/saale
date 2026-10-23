# Saale — Agent Rules

Production app, live data. Never lose it.

## Skills — load before the work

| Area                                                  | File                                      |
| ----------------------------------------------------- | ----------------------------------------- |
| Migrations, any DB change                             | `.pi/skills/database-migrations/SKILL.md` |
| Any UI (pages, panels, forms, lists, modals, styling) | `.pi/skills/saale-design/SKILL.md`        |
| Pi sessions, prompts, models, tools                   | `.pi/skills/pi-agent-usage/SKILL.md`      |

Never edit `prisma.config.mjs` — it loads env; a change breaks deploys.

## Investigate before using

Never assume an API, method or type exists: read the source, `dist/`, `index.d.ts`
or docs, or probe it (`node -e "import(...)"`). Trace bugs to the code, not to
the error string.

## Commits

- Commit before moving on. Subject ≤50 chars, imperative, descriptive
  (`add prisma schema for users and sessions`). Group related changes.
- Run the checks that cover the change before committing — eslint `--fix` on the
  changed files (it formats too; `prettier --write` for `.md`/`e2e/`), then
  `NODE_OPTIONS=--max-old-space-size=1700 npx tsc --noEmit` when `.ts`/`.tsx`
  changed (`tsc` is whole-project; the heap flag avoids this box's 2 GB OOM
  kill), then `npx vitest run <paths|dir>` for the tests covering it.
- Widen to `npm run check` when the change reaches beyond a couple of files (a
  shared primitive, the Prisma schema, the agent runtime) or the run is cheap. If
  a check cannot run, say which and why.
- A PR runs `.github/workflows/checks.yml`: eslint, prettier and vitest on the
  touched files, and a cached project-wide `tsc`. Touched-file scope means a
  green check only covers your diff — still run `npm run check` for a wide
  change.
- Local build: `NODE_ENV=production npm run build`. With `NODE_ENV=development`
  it dies prerendering `/_global-error` — a known Next 16 symptom
  (vercel/next.js#86178), not this app's bug.

## Never swallow errors

- Every `catch` logs with context: `console.error("Failed to save draft:", err)`.
  No empty `catch {}`, no `.catch(() => {})`, no fire-and-forget without a log.
- Early-exit guards (`if (!x) return;`) are not error handling — no log needed.

## User isolation — critical

- Every query carries the owner: `where: { id, userId }`, even for IDs fetched
  earlier in the same function. An ID alone is guessable.
- Raw SQL: `prisma.$queryRaw` / `Prisma.sql` templates only, never
  `$queryRawUnsafe` with interpolation.
- Tools: `userId` closes over in `createXxxTools(userId)`; jobs: use
  `task.userId` from the resolved task, never the runner's context.

## Code style

- TS strict. No `any`. No `@ts-ignore` without a comment saying why.
- `zod` for runtime validation, `TypeBox` for Pi tool schemas.
- Server components by default; `"use client"` only when needed.
- `@/` imports; no relative import climbing more than 2 levels.
- No hardcoded config: env var, config module, or named constant — never a
  literal timeout, URL, threshold or key.
- Error boundaries around user-facing components.

## Thin routes, shared helpers

- A route authenticates, validates, delegates to `src/lib/`, responds. Business
  logic lives in `src/lib/`.
- Same work in two places (DB writes, email, state) → one helper in `src/lib/`.
  Prefer a named `saveCompactionMessage()` over a copy-pasted Prisma call.

## Tests

- Verify real behaviour with several inputs → expected outputs: API responses,
  auth, tool execution, parsing, scheduling, edge cases. No trivial tests.
- A new feature or non-trivial change gets a happy path and an edge case.
- A failing test: fix the code or the test. Never skip it.

## UI

- Load the design skill first; it is authoritative. Invariants:
  the shell never scrolls the body (no `h-dvh`/`h-screen`/`calc(100vh…)` in
  pages, scroll regions are `flex-1 min-h-0 overflow-y-auto`); no page titles;
  pages are built from `src/components/layout/page.tsx`; overlays never scroll
  horizontally; chat is the one full-bleed view.
- Enforced at 375px and 320px by `e2e/mobile-overflow.spec.ts`,
  `e2e/modal-overflow.spec.ts`, `e2e/chat-full-bleed.spec.ts` and
  `__tests__/overlay-coverage.test.ts`. A new overlay goes in
  `e2e/modal-scenarios.ts`.

## Mobile-first

- Responsive by default: `px-4 md:px-6`, `text-sm md:text-base`,
  `grid-cols-1 md:grid-cols-2`. Never fixed padding above `px-4` without a `md:`.
- Fixed widths (`w-96`) only inside their own `overflow-x-auto` box; else
  `max-w-`/responsive.
- Row actions work without hover: `ROW_ACTION` from `@/lib/utils`; destructive
  ones live behind the row menu.
- A list reused in a side panel takes its `dense` variant (`FileBrowser` is the
  reference) and never nests `GlassPanelContent`.

## No nested interactive elements

`<button>` in `<button>`, `<Button>` inside a base-ui trigger
(`Popover`/`DropdownMenu`/`Sheet`/`Dialog` `Trigger` render `<button>`) or inside
`<Link>` — all invalid HTML and a hydration error. Use a styled `<span>` or the
Button's own `onClick`. Unsure? Inspect the DOM.

## Settings

- Declared once in `src/lib/settings/properties.ts` — key, columns, validation,
  `apply: "sessions"`. Tools and routes read that registry.
- Never write `prisma.appSettings` / `prisma.adminSettings`: use `setSetting()` /
  `applyUserSettingsPatch()` / `applyAdminSettingsPatch()` in
  `src/lib/settings/update.ts` (ESLint rejects a direct write).
- A new column needs one registry entry —
  `__tests__/lib/settings/properties.test.ts` fails otherwise. Categories,
  purposes, tools and sidebar items are derived: no work.
- Admin-scope writes are role-checked at the write path, not only in the tool.

## Agent tools

- `defineStructuredTool` (`src/lib/pi/tools/tool-result.ts`), never Pi's
  `defineTool`; always declare an `outputSchema`
  (`__tests__/lib/pi/tool-results.test.ts` enforces it). Depth and pitfalls:
  pi-agent-usage skill.

## Layout

`src/app` routes · `src/components` UI (`ui/` = shadcn) · `src/lib` logic ·
`src/hooks` · `src/types` · `src/server` server-only (API, DB) · `prisma` schema
and migrations · `__tests__` unit/integration · `e2e` Playwright.

## Docker

`docker compose up` — app + postgres + redis, hot reload.
`docker compose build --target production` — production image.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
