# ─── Base ─────────────────────────────────────────────────────────────────────

FROM node:25-alpine AS base
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

# ─── Build stage (shared by web and worker) ──────────────────────────────────

FROM base AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm,sharing=locked npm ci --ignore-scripts
# Dummy URL so `prisma generate` can resolve env("DATABASE_URL") — build-time only
ENV DATABASE_URL="postgresql://prisma:prisma@localhost:5432/prisma"
# Prisma client and CLI closure follow from the schema, not from the app source,
# so they are prepared before `COPY . .` and survive ordinary source edits.
COPY prisma ./prisma
COPY prisma.config.mjs ./prisma.config.mjs
RUN npx prisma generate
# Stage the prisma CLI + closure for the slim production image (see scripts/bundle-prisma-cli.mjs)
COPY scripts/bundle-prisma-cli.mjs ./scripts/bundle-prisma-cli.mjs
RUN node scripts/bundle-prisma-cli.mjs /tmp/prisma-cli-bundle
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
# Prisma schema + migrations + config + generated client (not bundled by Next.js standalone)
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/prisma.config.mjs ./prisma.config.mjs
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
# Prisma CLI + closure for `migrate deploy` at boot (standalone tracer omits the CLI)
COPY --from=build /tmp/prisma-cli-bundle/ ./node_modules/

ENTRYPOINT ["dumb-init", "--"]
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"
CMD ["sh", "-c", "node node_modules/prisma/build/index.js migrate deploy && node server.js"]

# ─── Production: Worker (BullMQ, pre-compiled) ──────────────────────────────

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
