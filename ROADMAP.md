# Saale — Roadmap

> AI-powered productivity hub: email, chat, tasks — one interface.

## Tech Stack

| Layer | Choice | Why |
|-------|--------|-----|
| Frontend | Next.js 15 (App Router) + shadcn/ui + Tailwind 4 | SSR, API routes, shadcn for fast accessible UI |
| AI Engine | Pi SDK (`@earendil-works/pi-coding-agent`) | Streaming events, custom tools via `defineTool()`, session management. **No MCP** — tools are registered internally on the session. |
| Streaming | Server-Sent Events (SSE) | Simple, native browser support, one-way agent→UI |
| Database | PostgreSQL 17 + Prisma | Proper relational DB, migrations, type-safe queries |
| Queue / Cache | Redis 8 | Task queue, session state, rate limiting |
| Auth | next-auth v5 (Credentials provider + Prisma adapter) | Email/password auth, session management, database adapter |
| Email | IMAP/SMTP (`mailparser`) | Direct email access, no third-party API lock-in |
| Tests | Vitest (unit/integration) + Playwright (E2E) | Fast unit tests, real browser E2E |
| Linting | ESLint + Prettier | Consistent code style, Tailwind class sorting |
| CI/CD | Docker Compose (dev + prod) | Hot reload in dev, standalone build for prod |

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
│  │  │ Pi Session   │  │ Email Client │  │  Tasks  │ │ │
│  │  │ (SDK)        │  │ (IMAP/SMTP)  │  │ Engine  │ │ │
│  │  └──────┬───────┘  └──────┬───────┘  └───┬─────┘ │ │
│  │         │                 │               │       │ │
│  │  ┌──────▼─────────────────▼───────────────▼─────┐ │ │
│  │  │       Custom Tools (defineTool)               │ │ │
│  │  │  ┌──────────┬──────────┬──────────┬────────┐ │ │ │
│  │  │  │  Mail    │  Tasks   │  Files   │ Chat   │ │ │ │
│  │  │  └──────────┴──────────┴──────────┴────────┘ │ │ │
│  │  └──────────────────────────────────────────────┘ │ │
│  └───────────────────────────────────────────────────┘ │
│                       │  │                              │
│              ┌────────▼──▼────────┐                     │
│              │   PostgreSQL 17    │                     │
│              └────────────────────┘                     │
│                       │                                 │
│              ┌────────▼──────────┐                      │
│              │     Redis 8       │                      │
│              └───────────────────┘                      │
└─────────────────────────────────────────────────────────┘
```

## Pi Integration (No MCP)

Pi's philosophy is "No MCP" — tools are registered directly on the agent session via `defineTool()`. This gives the agent native access to email, tasks, and file operations without protocol overhead or subprocess boundaries.

```typescript
// lib/pi/session.ts
export async function createSession(userId, customTools) {
  const { session } = await createAgentSession({
    sessionManager: SessionManager.inMemory(),
    customTools,  // mail_list, mail_read, task_toggle, etc.
    authStorage,
    modelRegistry,
  });
  return session;
}
```

### Custom Tool Design

```typescript
// Email tools
defineTool({ name: "mail_list", ... })      // List emails (filters: folder, unread, since)
defineTool({ name: "mail_read", ... })      // Read email by ID
defineTool({ name: "mail_search", ... })    // Search emails by query
defineTool({ name: "mail_send", ... })      // Send email
defineTool({ name: "mail_tag", ... })       // Tag/untag emails
defineTool({ name: "mail_move", ... })      // Move email between folders

// Task tools
defineTool({ name: "task_list", ... })      // List all tasks + status
defineTool({ name: "task_toggle", ... })    // Enable/disable a task
defineTool({ name: "task_run", ... })       // Run a task manually
defineTool({ name: "task_logs", ... })      // View task run history
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

### Phase 1 — Chat (Week 1-2)

- [ ] Chat UI (message list, input bar, streaming render)
- [ ] SSE streaming endpoint (`/api/chat/stream`)
- [ ] Session management (new session, list, resume)
- [ ] Markdown rendering in messages (react-markdown + rehype-highlight)
- [ ] Tool call visibility (show when agent uses tools)
- [ ] Model/Thinking level selector
- [ ] Copy, delete, regenerate messages
- [ ] Chat history persistence in PostgreSQL

### Phase 2 — Email (Week 2-4)

- [ ] Email account connection UI (IMAP/SMTP config form)
- [ ] Password encryption/decryption (ENCRYPTION_KEY)
- [ ] IMAP sync service (background polling)
- [ ] Inbox view (message list, threading, read/unread)
- [ ] Message detail view (render HTML/plain text)
- [ ] Compose & send emails (SMTP)
- [ ] Folder/tag management
- [ ] Search across emails
- [ ] Pi email tools (`defineTool` registrations)

### Phase 3 — Queue Tasks (Week 4-5)

- [ ] Task engine (Redis-backed queue, enable/disable per task)
- [ ] Email Summarization task (auto-summarize new mail with Pi)
- [ ] Classification + Tags task (auto-tag incoming mail with Pi)
- [ ] Spam Filtering task (Pi evaluates spam score)
- [ ] Task run history & logs (viewable in UI)
- [ ] Task scheduling (IMAP poll interval, cron-like triggers)
- [ ] Task tools for Pi agent access

### Phase 4 — Cross-Feature (Week 5-6)

- [ ] Chat can reference emails ("summarize my last 5 emails")
- [ ] Chat can reference tasks ("disable spam filtering")
- [ ] Unified search (chat + email + tasks)
- [ ] Settings Panel (API keys, email accounts, model prefs, theme) - Movable Window, not a seperate page!
- [ ] Notifications (new email, task completed)
- [ ] Dark/light theme toggle

### Phase 5 — Polish (Week 6-7)

- [ ] Responsive design (mobile support)
- [ ] Keyboard shortcuts
- [ ] Error boundaries throughout
- [ ] Loading states and skeletons
- [ ] Docker production build optimization
- [ ] Deployment docs
- [ ] README, branding, logo

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
