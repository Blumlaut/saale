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
