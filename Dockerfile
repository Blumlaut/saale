# ─── Base ─────────────────────────────────────────────────────────────────────

FROM node:22-alpine AS base
RUN apk add --no-cache curl dumb-init

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

# ─── Build stage ──────────────────────────────────────────────────────────────

FROM base AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts
COPY . .
RUN npx prisma generate
RUN npm run build

# ─── Production stage — minimal, non-root user, standalone ────────────────────

FROM node:22-alpine AS production
WORKDIR /app
ENV NODE_ENV=production

# Create non-root user
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# Copy only necessary files from build
COPY --from=build /app/public ./public
COPY --from=build --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=build /app/prisma ./prisma

# Use dumb-init for proper signal handling
ENTRYPOINT ["dumb-init", "--"]

USER nextjs
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"
CMD ["node", "server.js"]
