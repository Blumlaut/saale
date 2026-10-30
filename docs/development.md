# Development

## A checkout

```bash
git clone https://github.com/Blumlaut/saale.git
cd saale
cp .env.example .env
```

Fill in `BETTER_AUTH_SECRET`, `ENCRYPTION_KEY`, `SANDBOX_API_KEY` and `WORKER_API_KEY`
(`openssl rand -hex 32` for the three that take hex), then run the whole stack:

```bash
docker compose up -d --build
```

That builds `web`, `worker`, `sandbox-exec` and the image their per-user containers run,
from this checkout. It is the source build; a deployment uses
[docker-compose.prod.yml](install.md), which pulls the same services as images.

## On the host

```bash
npm install
npx prisma generate
npm run dev          # http://localhost:3630, hot reload
npm run check        # lint, types, formatting, tests
npm test             # unit tests only
npm run test:e2e     # Playwright, against a production build
npm run test:e2e:dev # Playwright, against the dev server
npm run db:seed      # a written chat and a coder chat with a repo to look at
npm run shot -- /dashboard/infra --click "Add Machine"   # screenshots a route
npm run shot -- /dashboard/chat --theme dark             # the same, in dark mode
```

Outside Docker the app needs `DATABASE_URL`, `REDIS_URL` and a running Postgres and Redis.
Two scripts set that up and run a working checkout:

```bash
npm run dev:setup    # Postgres, Redis, a database and port of its own, .env, the schema, an account
npm run dev:start    # dev server and queue worker in the background
```

`dev:setup` starts the machine's Postgres and Redis, and installs them when they are
missing. It creates a database and a Redis index per checkout, keeps the port a checkout
already uses, and writes only its own block into `.env`. The account it seeds is
`dev` / `saale-dev-password` (`SEED_USERNAME`, `SEED_PASSWORD`). `DATABASE_URL`,
`REDIS_URL` and `PORT` override what it works out.

Afterwards `npm run dev:status`, `dev:stop`, `dev:restart` and `dev:logs` drive the two
background processes. Their pids and logs live in `.dev/`.

Checkouts each get their own database. To have several worktrees share one (same accounts,
same chats, same settings), set `DATABASE_URL` in `.env` above the block the script writes,
and setup keeps that database instead of creating one.

`npm run docker:dev` runs the whole stack with hot reload instead.

## Demo data

`npm run db:seed` fills the dev account with something to look at: a chat with a written
conversation, and a coder project with a real git repo and a chat working in a worktree of
it. Every row it owns has an id starting with `demo-`, so a second run replaces the demo
and leaves the rest of the account alone.

`SEED_EMAIL`, `SEED_USERNAME` and `SEED_PASSWORD` point it at another account, and it
creates that one when it is missing. Use a separate account when you want screenshots
without the scratch chats a dev account collects.

## Releases

A release is named after its month and counts up inside it: `2026.10.0`, `2026.10.1`,
then `2026.11.0` when November comes. `.0` is the month's first release, and the counter
resets every month, so a version never grows past the month plus one digit.

`.github/workflows/release.yml` runs once a day. When main has moved since the last tag
it:

1. builds the `saale`, `saale-worker` and `saale-sandbox` images and pushes them to GHCR
   as `<version>` and `latest`;
2. bumps `package.json`, commits `release <version>` and tags it;
3. publishes the GitHub release with notes from the commits since the last one.

A day with nothing new stops after the checkout, so a quiet repository costs nothing.
`workflow_dispatch` cuts a release on demand.

`scripts/release-version.sh` works out the next number from the tags, so it can be run
before a manual release:

```bash
sh scripts/release-version.sh           # this month
sh scripts/release-version.sh 2026-11   # a month of your choosing
```

The console footer shows the version a build came from. An image gets it through the
`NEXT_PUBLIC_APP_VERSION` build arg, and a checkout through `package.json`, which
`next.config.ts` reads.
