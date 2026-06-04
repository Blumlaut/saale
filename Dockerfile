# ─── Base ─────────────────────────────────────────────────────────────────────

FROM node:25-alpine AS base
RUN apk add --no-cache dumb-init

# ─── Dependencies ─────────────────────────────────────────────────────────────

FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts

# ─── Development stage — hot reload via docker compose watch ──────────────────

FROM base AS development
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts
COPY . .
CMD ["npm", "run", "dev"]

# ─── Build stage (shared by web and worker) ──────────────────────────────────

FROM base AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts
COPY . .
# Dummy URL so `prisma generate` can resolve env("DATABASE_URL") — not used at runtime
ENV DATABASE_URL="postgresql://prisma:prisma@localhost:5432/prisma"
RUN npx prisma generate
RUN npm run build

# ─── Production: Web (Next.js standalone) ─────────────────────────────────────

FROM node:25-alpine AS production
RUN apk add --no-cache dumb-init
WORKDIR /app
ENV NODE_ENV=production

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

COPY --from=build /app/public ./public
COPY --from=build --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/.next/static ./.next/static
# Prisma schema + migrations + generated client (not bundled by Next.js standalone)
COPY --from=build --chown=nextjs:nodejs /app/prisma ./prisma
COPY --from=build --chown=nextjs:nodejs /app/node_modules/.prisma ./node_modules/.prisma

COPY docker/entrypoint.sh /docker/entrypoint.sh
RUN chmod +x /docker/entrypoint.sh
ENTRYPOINT ["/docker/entrypoint.sh"]
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"
CMD ["sh", "-c", "npx prisma migrate deploy && node server.js"]

# ─── Production: Worker (BullMQ, tsx) ────────────────────────────────────────

FROM node:25-alpine AS production-worker
RUN apk add --no-cache dumb-init
WORKDIR /app
ENV NODE_ENV=production

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# Copy source + tsconfig + deps (tsx needs full source for @/ resolution)
COPY --from=build --chown=nextjs:nodejs /app/src ./src
COPY --from=build --chown=nextjs:nodejs /app/prisma ./prisma
COPY --from=build --chown=nextjs:nodejs /app/tsconfig.json ./tsconfig.json
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/package-lock.json ./package-lock.json

RUN npm ci --omit=dev --ignore-scripts && \
    chown -R nextjs:nodejs /app/node_modules

# Generate Prisma client (npm ci --ignore-scripts skips the prepare script)
ENV DATABASE_URL="postgresql://prisma:prisma@localhost:5432/prisma"
RUN npx prisma generate && \
    chown -R nextjs:nodejs /app/node_modules/.prisma

COPY docker/entrypoint.sh /docker/entrypoint.sh
RUN chmod +x /docker/entrypoint.sh
ENTRYPOINT ["/docker/entrypoint.sh"]
CMD ["sh", "-c", "TSCONFIG_PROJECT=/app/tsconfig.json ./node_modules/.bin/tsx src/lib/queue/worker.ts"]
