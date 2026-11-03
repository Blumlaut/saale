# ─── Base ─────────────────────────────────────────────────────────────────────

# The exact runtime comes from `devEngines.runtime`, which pnpm installs itself;
# this major only has to be one the app is known to start under.
FROM node:26-alpine AS base
RUN apk add --no-cache dumb-init
# pnpm ships as a self-contained binary and its image carries the node-gyp it
# needs. Copying that beats `npm install -g`, which leans on npm's global layout.
COPY --from=ghcr.io/pnpm/pnpm:12.16.1-alpine /opt/pnpm /opt/pnpm
RUN for bin in pnpm pn pnpx pnx; do ln -s "/opt/pnpm/$bin" "/usr/local/bin/$bin"; done
# The store is where pnpm keeps every package it has ever unpacked; each stage
# mounts it as a cache, so a rebuild links instead of downloading. pnpm 12 reads
# no `npm_config_*`, so the store dir has to be named in pnpm's own prefix.
ENV PNPM_CONFIG_STORE_DIR=/pnpm/store

# ─── Store ───────────────────────────────────────────────────────────────────
#
# `pnpm fetch` fills the store from the lockfile without touching node_modules,
# so a manifest edit alone never re-fetches and the layer is keyed on
# pnpm-lock.yaml. Every stage below builds on this one, which is how their
# installs find the store warm.

FROM base AS fetched
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
# Fetch reads the patch files the lockfile names, so they arrive with it.
COPY patches ./patches
RUN --mount=type=cache,target=/pnpm/store,sharing=locked pnpm fetch

# ─── Development stage — hot reload via docker compose watch ──────────────────

FROM fetched AS development
WORKDIR /app
COPY package.json ./
# `prepare` regenerates the Prisma client during the install, so the schema goes
# in first. Dummy URL so `prisma generate` can resolve env("DATABASE_URL") —
# build-time only.
ENV DATABASE_URL="postgresql://prisma:prisma@localhost:5432/prisma"
COPY prisma ./prisma
COPY prisma.config.mjs ./prisma.config.mjs
RUN --mount=type=cache,target=/pnpm/store,sharing=locked pnpm install --frozen-lockfile --prefer-offline
COPY . .
CMD ["pnpm", "run", "dev"]

# ─── Production dependencies ─────────────────────────────────────────────────
#
# Installed apart from `build` so the layer is keyed on pnpm-lock.yaml alone: an
# ordinary source change must never re-run the install or rewrite the node_modules
# layer it produces. `--prod` skips `prepare`, so the client is generated here by
# hand.

FROM fetched AS prod-deps
WORKDIR /app
COPY package.json ./
RUN --mount=type=cache,target=/pnpm/store,sharing=locked pnpm install --frozen-lockfile --prod --prefer-offline
# Dummy URL so `prisma generate` can resolve env("DATABASE_URL") — build-time only
ENV DATABASE_URL="postgresql://prisma:prisma@localhost:5432/prisma"
COPY prisma ./prisma
COPY prisma.config.mjs ./prisma.config.mjs
RUN pnpm exec prisma generate
# Exercise the migrate path offline (config + schema engine, no DB): a Prisma
# upgrade that changes the CLI's contract fails the build, not the deploy.
RUN node node_modules/prisma/build/index.js migrate diff \
      --from-empty --to-schema prisma/schema.prisma --script > /dev/null

# ─── Build stage: web ────────────────────────────────────────────────────────

FROM fetched AS build
WORKDIR /app
COPY package.json ./
# Dummy URL so `prisma generate` can resolve env("DATABASE_URL") — build-time only
ENV DATABASE_URL="postgresql://prisma:prisma@localhost:5432/prisma"
# The client follows from the schema, not from the app source, so the install that
# generates it runs before `COPY . .` and survives ordinary source edits.
COPY prisma ./prisma
COPY prisma.config.mjs ./prisma.config.mjs
RUN --mount=type=cache,target=/pnpm/store,sharing=locked pnpm install --frozen-lockfile --prefer-offline
COPY . .
# The release this image carries, inlined by `next build`. The release workflow
# passes it; a local build falls back to package.json through next.config.ts.
ARG NEXT_PUBLIC_APP_VERSION=
ENV NEXT_PUBLIC_APP_VERSION=$NEXT_PUBLIC_APP_VERSION
# `.next/cache` holds Turbopack's build cache and the incremental typecheck info
# — mounted so rebuilds start warm instead of retyping and recompiling everything
RUN --mount=type=cache,target=/app/.next/cache,sharing=locked pnpm run build

# ─── Build stage: worker and sandbox bundles ─────────────────────────────────
#
# Apart from the web build on purpose: the worker image takes the two esbuild
# bundles and none of `.next`, so a release should not pay for a Next build on
# both of its two legs.

FROM fetched AS build-worker
WORKDIR /app
COPY package.json ./
ENV DATABASE_URL="postgresql://prisma:prisma@localhost:5432/prisma"
COPY prisma ./prisma
COPY prisma.config.mjs ./prisma.config.mjs
RUN --mount=type=cache,target=/pnpm/store,sharing=locked pnpm install --frozen-lockfile --prefer-offline
COPY . .
RUN pnpm run build:worker
RUN pnpm run build:sandbox

# ─── Production: Web (Next.js standalone) ─────────────────────────────────────

FROM base AS production
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/public ./public
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
# The console reads this to show what the running release changed.
COPY --from=build /app/CHANGELOG.md ./CHANGELOG.md
# Nothing at runtime reads the schema or prisma.config.mjs in this container: the
# app builds its client from DATABASE_URL (src/lib/db.ts) and migrations run in
# the `migrate` service, not in this container. Next traces the generated client
# out of the pnpm virtual store on its own.

ENTRYPOINT ["dumb-init", "--"]
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"
CMD ["node", "server.js"]

# ─── Production: Worker (BullMQ, pre-compiled) ──────────────────────────────
#
# Also the image the `migrate` service runs: it carries the full production
# dependency tree — hence a real, installed `prisma` CLI — plus prisma/ and
# prisma.config.mjs.

FROM base AS production-worker
WORKDIR /app
ENV NODE_ENV=production

# Runtime deps, Prisma client already generated in `prod-deps`
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/package.json ./package.json
# Pre-compiled worker binary, sandbox service + prisma schema
COPY --from=build-worker /app/dist/worker.mjs ./worker.mjs
COPY --from=build-worker /app/dist/sandbox.mjs ./sandbox.mjs
COPY --from=build-worker /app/prisma ./prisma
COPY --from=build-worker /app/prisma.config.mjs ./prisma.config.mjs

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "worker.mjs"]
