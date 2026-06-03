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
docker compose up
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
```

### Docker Development

```bash
# Start all services with hot reload
docker compose up

# Watch mode (rebuilds on file changes)
docker compose watch
```

## Environment Variables

| Variable               | Description                                                   | Required  |
| ---------------------- | ------------------------------------------------------------- | --------- |
| `DATABASE_URL`         | PostgreSQL connection string                                  | Yes       |
| `REDIS_URL`            | Redis connection string                                       | Yes       |
| `BETTER_AUTH_SECRET`   | Secret for session encryption (32+ chars)                     | Yes       |
| `BETTER_AUTH_URL`      | Public base URL of the app                                    | Yes       |
| `ENCRYPTION_KEY`       | 64-char hex string for email password encryption              | Yes       |
| `OPEN_TERMINAL_URL`    | Open Terminal API base URL                                    | Yes*      |
| `OPEN_TERMINAL_API_KEY`| API key for Open Terminal authentication                      | Yes*      |
| `SEARXNG_URL`          | SearXNG instance URL for web search                           | No        |
| `UPLOADS_DIR`          | Path for user file storage                                    | No        |

*\* Required only when bash tools are enabled.*

Generate secrets:
```bash
# ENCRYPTION_KEY (64-char hex)
openssl rand -hex 32

# OPEN_TERMINAL_API_KEY (64-char hex)
openssl rand -hex 32
```

## Production

```bash
# Build production image
docker compose build --target production

# Run with production config
BUILD_TARGET=production docker compose up -d
```

## Open Terminal (Sandboxed Execution)

When bash tools are enabled, all command execution and file operations run inside a Docker-isolated [open-terminal](https://github.com/open-webui/open-terminal) container:

- **Full dev environment** — Python 3, Node.js, git, build tools, data science libraries, ffmpeg, and more
- **Multi-user isolation** — Each Saale user gets a dedicated Linux account with kernel-enforced permissions
- **Session persistence** — Working directory is tracked per AI session via `X-Session-Id` header
- **Image support** — The read tool can return images (PNG, JPEG, GIF, WebP) as binary attachments

To enable, set `bash: true` in the user's tool config and ensure `OPEN_TERMINAL_URL` and `OPEN_TERMINAL_API_KEY` are configured.

## Naming

**Saale** — river through Jena (a place of connection)
