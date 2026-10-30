# Development

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
