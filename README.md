# Saale

> AI-powered productivity hub: email, chat, tasks — one interface.

Saale connects your email, AI chat, and background jobs into a single workspace. Powered by the Pi SDK for AI interactions, BullMQ for reliable job processing, and direct IMAP/SMTP for email — no third-party API lock-in.

## Features

- **AI Chat** — Conversational AI with streaming responses, tool calls, and persistent history
- **Email** — Direct IMAP/SMTP integration with background sync, compose, search, and AI-powered tagging
- **Job Queue** — BullMQ-powered background jobs with cron scheduling, retries, and observability
- **File Workspace** — Per-user file storage with read/write/list/delete tools for the AI agent
- **Unified Search** — Search across chat history and email in one interface
- **Notifications** — In-app notification center with real-time updates

## Tech Stack

| Layer     | Choice                                           |
| --------- | ------------------------------------------------ |
| Frontend  | Next.js 15 (App Router) + shadcn/ui + Tailwind 4 |
| AI Engine | Pi SDK (`@earendil-works/pi-coding-agent`)       |
| Database  | PostgreSQL 17 + Prisma                           |
| Queue     | BullMQ + Redis 8                                 |
| Auth      | better-auth v1                                   |
| Email     | imapflow + nodemailer + mailparser               |
| Tests     | Vitest + Playwright                              |

## Quick Start

```bash
# Clone and install
git clone https://github.com/Blumlaut/saale.git
cd saale
npm install

# Set up environment variables
cp .env.example .env
# Edit .env with your secrets

# Start everything with hot reload
docker compose up

# Or run locally (with Postgres + Redis running)
npm run dev
```

The app will be available at http://localhost:3000.

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

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                    Browser                          │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐         │
│  │  Chat UI  │  │ Mail UI  │  │ Task UI  │         │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘         │
│       │ SSE          │ REST        │ REST           │
│  ┌────▼──────────────────────────────────────────┐ │
│  │              Next.js Server                    │ │
│  │  ┌──────────────┐  ┌──────────────┐          │ │
│  │  │ Pi Session   │  │ Email Client │  │ Jobs  │ │
│  │  │ (per-user)   │  │ (IMAP/SMTP)  │  │Engine │ │
│  │  └──────┬───────┘  └──────┬───────┘  └───┬───┘ │ │
│  │         │                 │               │     │ │
│  │  ┌──────▼─────────────────▼───────────────▼───┐ │ │
│  │  │       Custom Tools (defineTool)             │ │ │
│  │  │  ┌──────────┬──────────┬──────────┐        │ │ │
│  │  │  │  Mail    │  Tasks   │  Files   │        │ │ │
│  │  │  └──────────┴──────────┴──────────┘        │ │ │
│  │  └────────────────────────────────────────────┘ │ │
│  └─────────────────────────────────────────────────┘ │
│                       │                              │
│              ┌────────▼────────┐                     │
│              │   PostgreSQL 17 │                     │
│              └─────────────────┘                     │
│                       │                              │
│              ┌────────▼────────┐                     │
│              │     Redis 8     │ ← BullMQ queues     │
│              └─────────────────┘                     │
└─────────────────────────────────────────────────────┘
```

## Environment Variables

| Variable             | Description                                      | Required                  |
| -------------------- | ------------------------------------------------ | ------------------------- |
| `DATABASE_URL`       | PostgreSQL connection string                     | Yes                       |
| `REDIS_URL`          | Redis connection string                          | Yes                       |
| `BETTER_AUTH_SECRET` | Secret for session encryption                    | Yes                       |
| `BETTER_AUTH_URL`    | Base URL for the app                             | Yes                       |
| `ENCRYPTION_KEY`     | 64-char hex string for email password encryption | Yes                       |
| `UPLOADS_DIR`        | Path for user file storage                       | No (default: `./uploads`) |

## Production

```bash
# Build production image
docker compose build --target production

# Run with production config
BUILD_TARGET=production docker compose up -d
```

## Naming

**Saale** — river through Jena (a place of connection)
