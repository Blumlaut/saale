# ─── Base ─────────────────────────────────────────────────────────────────────

FROM node:26-alpine AS base
RUN apk add --no-cache dumb-init

# ─── Development stage — hot reload via docker compose watch ──────────────────

FROM base AS development
WORKDIR /app
COPY package.json package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm,sharing=locked npm ci --ignore-scripts
COPY . .
CMD ["npm", "run", "dev"]

# ─── Production dependencies ─────────────────────────────────────────────────
#
# Installed apart from `build` so the layer is keyed on package-lock.json alone:
# an ordinary source change must never re-run `npm ci --omit=dev` (~20s) or
# rewrite the ~1GB node_modules layer it produces.

FROM base AS prod-deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm,sharing=locked npm ci --omit=dev --ignore-scripts
# Dummy URL so `prisma generate` can resolve env("DATABASE_URL") — build-time only
ENV DATABASE_URL="postgresql://prisma:prisma@localhost:5432/prisma"
COPY prisma ./prisma
COPY prisma.config.mjs ./prisma.config.mjs
RUN npx prisma generate
# Exercise the migrate path offline (config + schema engine, no DB): a Prisma
# upgrade that changes the CLI's contract fails the build, not the deploy.
RUN node node_modules/prisma/build/index.js migrate diff \
      --from-empty --to-schema prisma/schema.prisma --script > /dev/null

# ─── Build stage (shared by web and worker) ──────────────────────────────────

FROM base AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm,sharing=locked npm ci --ignore-scripts
# Dummy URL so `prisma generate` can resolve env("DATABASE_URL") — build-time only
ENV DATABASE_URL="postgresql://prisma:prisma@localhost:5432/prisma"
# The client follows from the schema, not from the app source, so it is generated
# before `COPY . .` and survives ordinary source edits.
COPY prisma ./prisma
COPY prisma.config.mjs ./prisma.config.mjs
RUN npx prisma generate
COPY . .
# `.next/cache` holds Turbopack's build cache and the incremental typecheck info
# — mounted so rebuilds start warm instead of retyping and recompiling everything
RUN --mount=type=cache,target=/app/.next/cache,sharing=locked npm run build
RUN npm run build:worker

# ─── Production: Web (Next.js standalone) ─────────────────────────────────────

FROM base AS production
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/public ./public
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
# The generated client is not traced by Next.js standalone, so copy it. Nothing
# at runtime reads the schema or prisma.config.mjs in this container: the app
# builds its client from DATABASE_URL (src/lib/db.ts) and migrations run in the
# `migrate` service, not in this container.
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma

ENTRYPOINT ["dumb-init", "--"]
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"
CMD ["node", "server.js"]

# ─── Production: Worker (BullMQ, pre-compiled) ──────────────────────────────
#
# Also the image the `migrate` service runs: it carries the full production
# dependency tree — hence a real, npm-installed `prisma` CLI — plus prisma/ and
# prisma.config.mjs.

FROM base AS production-worker
WORKDIR /app
ENV NODE_ENV=production

# Runtime deps, Prisma client already generated in `prod-deps`
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/package.json ./package.json
# Pre-compiled worker binary + prisma schema
COPY --from=build /app/dist/worker.mjs ./worker.mjs
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/prisma.config.mjs ./prisma.config.mjs

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "worker.mjs"]
