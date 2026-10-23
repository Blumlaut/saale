# Saale

> AI-powered personal workspace: chat, email, calendar, tasks — one interface.

Saale connects your email, calendar, AI chat, and background automation into a single workspace. Powered by the Pi SDK for agentic AI, BullMQ for reliable job processing, and direct IMAP/SMTP & CalDAV protocol integrations — no third-party API lock-in.

## Features

- **AI Chat** — Conversational AI with streaming responses, tool calls, persistent history, and configurable models
- **Email** — Direct IMAP/SMTP integration with background sync, compose, search, AI-powered drafts, and tagging
- **Calendar** — CalDAV integration with subscription sync, event management, and AI-powered extraction from emails
- **Job Queue** — BullMQ-powered background jobs with cron scheduling, retries, and observability
- **Memory** — Persistent AI memory collections with tagging and semantic search across your knowledge
- **Web Tools** — Built-in web search (SearXNG) and URL fetching with browser TLS fingerprinting
- **Sandboxed Bash** — Optional Docker-isolated terminal (open-terminal) for code execution, file operations, and data processing
- **File Workspace** — Per-user file storage with read/write/edit tools; supports images when bash is enabled
- **Unified Search** — Search across chat history, email, and calendar in one interface
- **Installable App** — Web app manifest, generated icon set, offline fallback page, and a safe-area-aware shell for home-screen installs
- **Per-User Isolation** — Every database query and file operation is scoped to the authenticated user

## Tech Stack

| Layer         | Choice                                                         |
| ------------- | -------------------------------------------------------------- |
| Frontend      | Next.js 15 (App Router) + shadcn/ui + Tailwind 4               |
| AI Engine     | Pi SDK (`@earendil-works/pi-coding-agent`)                     |
| Database      | PostgreSQL 17 + Prisma                                         |
| Queue         | BullMQ + Redis 8                                               |
| Auth          | better-auth v1                                                 |
| Email         | imapflow + nodemailer + mailparser                             |
| Calendar      | CalDAV client + iCalendar parsing                              |
| Terminal      | [open-terminal](https://github.com/open-webui/open-terminal)    |
| Web Search    | SearXNG                                                        |
| Tests         | Vitest + Playwright                                            |

## Quick Start

```bash
# Clone and install
git clone https://github.com/Blumlaut/saale.git
cd saale
npm install

# Set up environment variables
cp .env.example .env
# Edit .env with your secrets (see Environment Variables below)

# Start everything with hot reload
npm run docker:dev
```

The app will be available at http://localhost:3000.

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                        Browser                                   │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌──────────┐  │
│  │  Chat    │ │  Email  │ │Calendar │ │  Tasks  │ │  Admin   │  │
│  └────┬─────┘ └────┬────┘ └────┬────┘ └────┬────┘ └────┬─────┘  │
│       │ SSE/REST    │ REST      │ REST      │ REST      │ REST   │
│  ┌────▼─────────────────────────────────────────────────────────┐│
│  │                   Next.js Server                              ││
│  │  ┌──────────────┐ ┌──────────────┐ ┌──────────────────────┐  ││
│  │  │ Pi Session   │ │ Email Client │ │  Calendar Engine     │  ││
│  │  │ (per-user)   │ │ (IMAP/SMTP)  │ │  (CalDAV + iCalendar)│  ││
│  │  └──────┬───────┘ └──────┬───────┘ └──────────┬───────────┘  ││
│  │         │                │                     │              ││
│  │  ┌──────▼────────────────▼─────────────────────▼──────────┐  ││
│  │  │              Custom Tools (defineTool)                   │  ││
│  │  │  Mail │ Jobs │ Calendar │ Memory │ Web │ Chat │ Files   │  ││
│  │  └─────────────────────────────────────────────────────────┘  ││
│  └───────────────────────────────────────────────────────────────┘│
│                            │                                      │
│         ┌──────────────────┼──────────────────┐                   │
│         │                  │                  │                   │
│  ┌──────▼──────┐   ┌───────▼──────┐  ┌───────▼──────┐           │
│  │ PostgreSQL  │   │    Redis     │  │ open-terminal │           │
│  │   (Prisma)  │   │  (BullMQ)    │  │  (sandboxed)  │           │
│  └─────────────┘   └──────────────┘  └──────────────┘           │
└──────────────────────────────────────────────────────────────────┘
```

### Tool Backends

| Tools          | Default (bash off) | Bash enabled              |
| -------------- | ------------------ | ------------------------- |
| read / write / edit | Local filesystem (fast) | Open Terminal (sandboxed, supports images) |
| bash           | — (disabled)       | Open Terminal (Docker container) |
| email          | IMAP/SMTP (direct) | —                         |
| calendar       | CalDAV (direct)    | —                         |
| web search     | SearXNG            | —                         |
| memory         | PostgreSQL         | —                         |
| jobs           | BullMQ/Redis       | —                         |

## Development

```bash
# Full check (lint + typecheck + format + tests)
npm run check

# Database
npm run db:migrate   # Apply migrations
npm run db:studio    # Prisma GUI

# Tests
npm test             # Vitest unit tests
npm run test:e2e     # Playwright E2E tests

# PWA
npm run pwa:icons    # Regenerate the icon set from the brand mark
```

### Docker

The project uses two compose files layered together:

- **`docker-compose.yml`** — base config (production defaults)
- **`docker-compose.dev.yml`** — dev overrides (build target, hot reload command)

```bash
# Dev mode — hot reload via docker compose watch
npm run docker:dev
# or: docker compose -f docker-compose.yml -f docker-compose.dev.yml watch

# Production mode — standalone Next.js server
npm run docker:prod
# or: docker compose up
```

The dev override only changes `build.target`, `NODE_ENV`, and the startup command — everything else (volumes, dependencies, infrastructure services) is shared from the base file.

## Environment Variables

| Variable               | Description                                                   | Required  |
| ---------------------- | ------------------------------------------------------------- | --------- |
| `DATABASE_URL`         | PostgreSQL connection string                                  | Yes       |
| `REDIS_URL`            | Redis connection string                                       | Yes       |
| `BETTER_AUTH_SECRET`   | Secret for session encryption (32+ chars)                     | Yes       |
| `BETTER_AUTH_URL`      | Public base URL of the app; also the base for OAuth redirects and the Telegram webhook | Yes |
| `ENCRYPTION_KEY`       | 64-char hex string for email password encryption              | Yes       |
| `SANDBOX_URL`          | Sandbox service base URL (commands run in per-workspace containers) | Yes* |
| `SANDBOX_API_KEY`      | Bearer key for the sandbox service                            | Yes*      |
| `SANDBOX_WORKSPACES_DIR` | Mount point of the workspaces volume (default `/workspaces`) | No       |
| `SANDBOX_USER`         | Account commands run as: `root` (installs) or `agent` (tighter) | No      |
| `SEARXNG_URL`          | SearXNG instance URL for web search                           | No        |
| `NGROK_URL`            | Dev tunnel in front of the app; overrides `BETTER_AUTH_URL` for webhook registration | No |
| `UPLOADS_DIR`          | Path for user file storage                                    | No        |

*\* Required only when bash tools are enabled.*

Generate secrets:
```bash
# ENCRYPTION_KEY (64-char hex)
openssl rand -hex 32

# SANDBOX_API_KEY (64-char hex)
openssl rand -hex 32
```

## Production

```bash
# Build and start production image
npm run docker:prod
# or: docker compose up -d
```

The base compose file defaults to the `production` build target — a minimal standalone Next.js server with no dev tools.

## Installable App (PWA)

The dashboard ships a web app manifest (`src/app/manifest.ts`), a generated icon
set (`public/icons`), and a service worker (`public/sw.js`) that precaches
`/offline` and serves it whenever a navigation fails.

- **Installing requires HTTPS** (or `localhost`). TLS terminates at the nginx
  proxy, and `BETTER_AUTH_URL` must match that origin or sign-in is rejected as
  an invalid origin.
- **The service worker never caches navigations or `/api/` responses.** The
  dashboard is authenticated and live-data: a cached page would serve one user's
  mail and chat state to the next session on a shared device. Only the offline
  fallback page and content-hashed `/_next/static/*` assets are cached.
- Icons are generated from `src/lib/pwa/brand.json`; run `npm run pwa:icons`
  after changing the palette or the mark.

## Open Terminal (Sandboxed Execution)

When bash tools are enabled, every identity gets its own container holding one directory of the `saale_workspaces` volume (`src/sandbox/` holds the service, `src/lib/sandbox/` the app side):

- **Full dev environment** — Python 3, Node.js, git, build tools, ffmpeg, chromium, and `gh` from `Dockerfile.sandbox`
- **Per-workspace isolation** — a container mounts only its own directory, so another user's files are not at any path
- **Streamed output** — stdout and stderr arrive as produced, and a stop kills the process group
- **Image support** — The read tool can return images (PNG, JPEG, GIF, WebP) as binary attachments
- **User variables** — a user's encrypted environment variables reach their commands, and `GH_TOKEN` authenticates `gh`

To enable, set `bash: true` in the user's tool config and configure `SANDBOX_URL` and `SANDBOX_API_KEY` (see `docker-compose.yml` and `plans/sandbox-service.md`).

Files moved off the old `saale_open-terminal-data` volume once, on 2026-10-22; the volume can be deleted after the workspaces have been checked.

## Naming

**Saale** — river through Jena (a place of connection)
