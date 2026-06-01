# Saale — Roadmap

> AI-powered productivity hub: email, chat, tasks — one interface.

## Principles

- **Production-grade from day one.** No hacks, no "we'll refactor later." Every decision assumes a team of 30 will maintain this.
- **Multi-user from the start.** Per-user data isolation, per-user Pi sessions. Workspace support deferred to post-v1.
- **Composable tools.** Tools accept arrays, pagination, filters — the AI chains them. No separate "bulk" variants.
- **BullMQ for everything queued.** Consistent architecture: retries, rate limiting, concurrency, observability — all native.

## Tech Stack

| Layer     | Choice                                                      | Why                                                                                                                                 |
| --------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Frontend  | Next.js 15 (App Router) + shadcn/ui + Tailwind 4            | SSR, API routes, shadcn for fast accessible UI                                                                                      |
| AI Engine | Pi SDK (`@earendil-works/pi-coding-agent`)                  | Streaming events, custom tools via `defineTool()`, session management. **No MCP** — tools are registered internally on the session. |
| Streaming | Server-Sent Events (SSE)                                    | Simple, native browser support, one-way agent→UI                                                                                    |
| Database  | PostgreSQL 17 + Prisma                                      | Proper relational DB, migrations, type-safe queries                                                                                 |
| Queue     | BullMQ + Redis 8                                            | Job queue with retries, rate limiting, concurrency, cron scheduling                                                                 |
| Auth      | better-auth v1 (Credentials provider + Prisma adapter)      | Email/password auth, session management, database adapter                                                                           |
| Email     | IMAP: `imapflow`, SMTP: `nodemailer`, Parsing: `mailparser` | Direct email access, no third-party API lock-in                                                                                     |
| Files     | Local filesystem (`/uploads/{userId}/`)                     | Simple per-user storage, upgradeable to object storage later                                                                        |
| Tests     | Vitest (unit/integration) + Playwright (E2E)                | Fast unit tests, real browser E2E                                                                                                   |
| Linting   | ESLint + Prettier                                           | Consistent code style, Tailwind class sorting                                                                                       |
| CI/CD     | Docker Compose (dev + prod)                                 | Hot reload in dev, standalone build for prod                                                                                        |

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                      Browser                            │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────┐ │
│  │  Chat UI  │  │ Mail UI  │  │ Task UI  │  │ Auth   │ │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └───┬────┘ │
│       │ SSE          │ REST        │ REST       │ REST │
│  ┌────▼──────────────────────────────────────────────┐ │
│  │              Next.js Server                        │ │
│  │  ┌──────────────┐  ┌──────────────┐  ┌─────────┐ │ │
│  │  │ Pi Session   │  │ Email Client │  │  Jobs   │ │ │
│  │  │ (SDK, per-   │  │ (IMAP/SMTP)  │  │ Engine  │ │ │
│  │  │  user)       │  │              │  │ (BullMQ)│ │ │
│  │  └──────┬───────┘  └──────┬───────┘  └───┬─────┘ │ │
│  │         │                 │               │       │ │
│  │  ┌──────▼─────────────────▼───────────────▼─────┐ │ │
│  │  │       Custom Tools (defineTool)               │ │ │
│  │  │  ┌──────────┬──────────┬──────────┬────────┐ │ │ │
│  │  │  │  Mail    │  Tasks   │  Files   │ Chat   │ │ │ │
│  │  │  └──────────┴──────────┴──────────┴────────┘ │ │ │
│  │  └───────────────────────────────────────────────┘ │ │
│  └───────────────────────────────────────────────────┘ │
│                       │                                │
│              ┌────────▼────────┐                       │
│              │   PostgreSQL 17 │                       │
│              └─────────────────┘                       │
│                       │                                │
│              ┌────────▼────────┐                       │
│              │     Redis 8     │ ← BullMQ queues       │
│              └─────────────────┘                       │
└─────────────────────────────────────────────────────────┘
```

## Pi Integration (No MCP)

Pi's philosophy is "No MCP" — tools are registered directly on the agent session via `defineTool()`. Each user gets an isolated Pi session with access only to their own data.

```typescript
// lib/pi/session.ts
export async function createSession(userId, customTools) {
  const { session } = await createAgentSession({
    sessionManager: SessionManager.inMemory(),
    customTools, // mail_list, mail_read, task_toggle, etc.
    authStorage,
    modelRegistry, // pulled from Pi's registry
  });
  return session;
}
```

### Custom Tool Design

Tools are composable — they accept arrays, pagination, and filters. The AI chains them as needed.

```typescript
// Email tools
defineTool({ name: "mail_list", ... })       // List emails (filters: folder, unread, since, limit, offset)
defineTool({ name: "mail_read", ... })       // Read email(s) by ID(s) — accepts array
defineTool({ name: "mail_search", ... })     // Search emails by query
defineTool({ name: "mail_send", ... })       // Send email
defineTool({ name: "mail_tag", ... })        // Tag/untag email(s) — accepts array of IDs
defineTool({ name: "mail_move", ... })       // Move email(s) between folders — accepts array
defineTool({ name: "mail_delete", ... })     // Delete email(s) — accepts array

// Task/Job tools
defineTool({ name: "job_list", ... })        // List all jobs + status
defineTool({ name: "job_enable", ... })      // Enable/disable a job
defineTool({ name: "job_run", ... })         // Run a job manually
defineTool({ name: "job_logs", ... })        // View job run history

// File tools
defineTool({ name: "file_read", ... })       // Read file from user's workspace
defineTool({ name: "file_write", ... })      // Write file to user's workspace
defineTool({ name: "file_list", ... })       // List files in user's workspace
defineTool({ name: "file_attach", ... })     // Attach file to current chat

// Chat tools
defineTool({ name: "chat_search", ... })     // Search chat history
```

## Phases

### Phase 0 — Scaffold ✅ (Done)

- [x] Next.js + shadcn/ui project scaffold
- [x] Docker Compose (Postgres 17 + Redis 8 + app with hot reload)
- [x] Prisma schema (users, auth, chat, email, tasks, settings)
- [x] next-auth v5 (Credentials provider, Prisma adapter)
- [x] Auth pages (login, register) + API routes
- [x] Dashboard layout with sidebar navigation
- [x] Placeholder pages (chat, mail, tasks, settings)
- [x] ESLint + Prettier config
- [x] Vitest + Playwright test setup
- [x] AGENTS.md (commit rules, testing rules, architecture)
- [x] Pi SDK integration layer (`lib/pi/session.ts`)

### Phase 1 — Chat

> Get the AI plumbing working. Everything else feeds into this.
>
> **Decisions:** Model selector pulls from Pi's `modelRegistry` at runtime. File uploads via native Next.js RouteHandler (local fs, no UploadThing). BullMQ installed early for Phase 2 email sync.

- [ ] Chat UI (message list, input bar, streaming render)
- [ ] SSE streaming endpoint (`/api/chat/stream`)
- [ ] Per-user Pi session management (create, list, resume, isolate)
- [ ] Markdown rendering in messages (react-markdown + rehype-highlight)
- [ ] Tool call visibility (show when agent uses tools, with status)
- [ ] Model selector (pull from Pi's `modelRegistry`)
- [ ] Thinking level selector
- [ ] Copy, delete, regenerate messages
- [ ] Chat history persistence in PostgreSQL
- [ ] File attachments (user → agent): upload, preview, attach to messages
- [ ] File tools for agent (`file_read`, `file_write`, `file_list`, `file_attach`)
- [ ] Per-user file workspace (`/uploads/{userId}/`)

### Phase 2 — Email

> Background sync is core — not an afterthought. BullMQ recurring jobs + manual trigger.
>
> **Decisions:** `imapflow` for IMAP (auto-handles extensions, mailbox locking, async iterators), `nodemailer` for SMTP. Incremental sync via IMAP UIDVALIDITY + HIGHESTMODSEQ. BullMQ infra built before this phase (per user preference). Phase 2 completes fully before Phase 3 starts.

- [ ] Email account connection UI (IMAP/SMTP config form)
- [ ] Password encryption/decryption (`ENCRYPTION_KEY` env)
- [ ] IMAP sync service as BullMQ recurring job (configurable interval per account)
- [ ] Manual sync trigger (button in UI, also exposed as API endpoint)
- [ ] Sync status visibility (last synced, in-progress, errors)
- [ ] Inbox view (flat chronological list, read/unread, starred)
- [ ] Message detail view (render HTML/plain text)
- [ ] Compose & send emails (SMTP)
- [ ] Folder management (list, move between folders)
- [ ] Tag system (apply/remove tags, filter by tag)
- [ ] Search across emails (PostgreSQL full-text search)
- [ ] Pi email tool registrations (`mail_list`, `mail_read`, `mail_search`, `mail_send`, `mail_tag`, `mail_move`, `mail_delete`)

### Phase 3 — Job Queue

> BullMQ-powered job engine. Templates + custom jobs. Cron scheduling. Per-job AI model selection from Pi's registry.
>
> **Decisions:** `QueueTask` schema extended with `name`, `cronExpression`, `modelId`, `retryPolicy` fields upfront. Sequential after Phase 2 — email-specific templates wired in here.

- [ ] BullMQ infrastructure (connection, queue registry, worker process)
- [ ] Job schema (explicit fields: `type`, `name`, `enabled`, `cronExpression`, `modelId`, `retryPolicy`; JSON `config` for job-specific settings)
- [ ] Job run tracking (status, input, output, error, timestamps, duration)
- [ ] Predefined job templates:
  - Email Summarization (auto-summarize new mail with Pi)
  - Classification + Tags (auto-tag incoming mail with Pi)
  - Spam Filtering (Pi evaluates spam score)
- [ ] Custom job creation (user-defined name, cron schedule, model, config)
- [ ] Job admin UI:
  - Job list with status, next run, run count
  - Job detail card (settings, model selector, cron editor, enable/disable)
  - Run history per job (logs, output, errors)
  - Manual "run now" trigger
- [ ] Job tools for Pi agent access (`job_list`, `job_enable`, `job_run`, `job_logs`)
- [ ] Rate limiting per job (concurrency, max executes per interval)
- [ ] Retry policy per job (attempts, backoff strategy)

### Phase 4 — Cross-Feature

> Chat references email, jobs, files. Unified search. Notifications.
>
> **Decisions:** Settings page replaced with floating draggable panel. Full browser push (Service Worker) + in-app notification center.

- [ ] Chat can reference emails ("summarize my last 5 emails") — AI chains `mail_list` → `mail_read` → generates response
- [ ] Chat can reference jobs ("disable spam filtering", "show me recent job logs")
- [ ] Chat can reference files ("what's in my notes?", "create a summary doc")
- [ ] Unified search (chat + email) via PostgreSQL full-text search
  - Single search bar, tabbed or mixed results
  - **Future:** vector search (pgvector) for semantic matching
- [ ] Settings Panel — floating draggable window (not a separate page)
  - API keys / model preferences (from Pi registry)
  - Email accounts (add, edit, test connection, sync now)
  - Theme (dark/light/system)
  - Email sync interval
- [ ] Notifications:
  - Browser push (Notification API)
  - In-app notification center (bell icon, dropdown with history)
  - Triggers: new email, job completed/failed, chat response ready

### Phase 5 — Polish

> Responsive, accessible, deployable.

- [ ] Responsive design (mobile support)
- [ ] Keyboard shortcuts (new chat, search, navigate, compose)
- [ ] Error boundaries throughout
- [ ] Loading states and skeletons
- [ ] Docker production build optimization (multi-stage, minimal image)
- [ ] Deployment documentation
- [ ] README, branding, logo

## Post-v1 (Future)

- [ ] Vector search (pgvector) for semantic email/chat search
- [ ] Shared workspaces (multi-user collaboration on jobs, shared email accounts)
- [ ] Event-based job triggers (chat thresholds, email patterns, external webhooks)
- [ ] Object storage migration (S3/minio) for file workspace
- [ ] Email threading (conversation grouping by References/In-Reply-To)
- [ ] Additional email providers (Gmail API, Microsoft Graph)
- [ ] Plugin system for custom job types

## Development

```bash
# Start everything with hot reload
docker compose up

# Or locally (with Postgres + Redis running)
npm run dev

# Full check (lint + typecheck + format + tests)
npm run check

# Database
npm run db:migrate   # Apply migrations
npm run db:studio    # Prisma GUI
```

## Naming

- **Product**: Saale — river through Jena (a place of connection)
- **Repo**: `Blumlaut/saale` (private)
- **Domain**: TBD
