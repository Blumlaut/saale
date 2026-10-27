#!/bin/sh
# The server the e2e suite runs against.
#
#   E2E_SERVER=prod (default)   build into .next-e2e when the source is newer
#                              than the last build, then serve it
#   E2E_SERVER=dev              next dev on the checkout's port
#
# Playwright reuses whatever already answers on the port, so a running dev
# server wins over this script outside CI.
set -eu

cd "$(dirname "$0")/.."

PORT="${PORT:-$(sed -n 's/^PORT=//p' .env 2>/dev/null | tail -1)}"
PORT="${PORT:-3630}"

# Every request comes from 127.0.0.1. The middleware limits per IP and path, and
# better-auth limits its own endpoints per IP, so a run would spend its second
# half answering 429.
export AUTH_RATE_LIMIT=off
export RATE_LIMIT_MAX=100000

if [ "${E2E_SERVER:-prod}" = "dev" ]; then
  exec npx next dev --turbopack --port "$PORT"
fi

export NODE_ENV=production

# A build is only worth its two minutes when the source moved since the last
# one.
if [ ! -f .next/BUILD_ID ] ||
  [ -n "$(find src prisma public next.config.ts package.json -newer .next/BUILD_ID -print -quit 2>/dev/null)" ]; then
  printf '▸ Building the production bundle\n'
  npx next build
fi

exec npx next start --port "$PORT"
