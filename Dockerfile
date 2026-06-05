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
RUN npm run build:worker

# ─── Production: Web (Next.js standalone) ─────────────────────────────────────

FROM node:25-alpine AS production
RUN apk add --no-cache dumb-init
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/public ./public
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
# Prisma schema + migrations + generated client (not bundled by Next.js standalone)
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma

ENTRYPOINT ["dumb-init", "--"]
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"
CMD ["sh", "-c", "npx prisma migrate deploy && node server.js"]

# ─── Production: Worker (BullMQ, pre-compiled) ──────────────────────────────

FROM node:25-alpine AS production-worker
RUN apk add --no-cache dumb-init
WORKDIR /app
ENV NODE_ENV=production

# Pre-compiled worker binary + prisma schema for client generation
COPY --from=build /app/dist/worker.js ./worker.js
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/prisma.config.mjs ./prisma.config.mjs
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/package-lock.json ./package-lock.json

# Only production runtime deps (no tsx, no source needed)
RUN npm ci --omit=dev --ignore-scripts

# Generate Prisma client (npm ci --ignore-scripts skips the prepare script)
ENV DATABASE_URL="postgresql://prisma:prisma@localhost:5432/prisma"
RUN npx prisma generate

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "worker.js"]
