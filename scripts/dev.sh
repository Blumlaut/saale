#!/bin/sh
# This checkout's dev environment: Postgres and Redis, a database and a Redis
# index of its own, a free port, .env, dependencies, the schema, an account to
# sign in with, and the dev server.
#
#   sh scripts/dev.sh setup     the one-time work, safe to re-run
#   sh scripts/dev.sh start     dev server and queue worker in the background
#   sh scripts/dev.sh stop
#   sh scripts/dev.sh restart
#   sh scripts/dev.sh status    what is up, and on which port
#   sh scripts/dev.sh logs      follow both logs
#
# Reads and writes its own block in .env, and leaves the rest of the file alone.
# Override: DATABASE_URL, REDIS_URL, PORT, SEED_EMAIL, SEED_USERNAME,
# SEED_PASSWORD, SEED_NAME.
#
# `start` needs `setup` to have run once; `setup` starts nothing of the app.

set -eu

cd "$(dirname "$0")/.."

PG_HOST=127.0.0.1
PG_PORT=5432
PG_USER=saale
PG_PASSWORD=saale
REDIS_HOST=127.0.0.1
REDIS_PORT=6379

DEV_DIR=.dev
APP_LOG="$DEV_DIR/app.log"
WORKER_LOG="$DEV_DIR/worker.log"

say() { printf '▸ %s\n' "$*"; }
warn() { printf '! %s\n' "$*" >&2; }
die() {
  printf '✗ %s\n' "$*" >&2
  exit 1
}

# Root is who we usually are here, but never assume it.
as_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  else
    sudo -n "$@" 2>/dev/null
  fi
}

tcp_open() { # host port — nothing to assume is installed, so probe with node
  node -e '
    const socket = require("node:net").connect(Number(process.argv[2]), process.argv[1]);
    socket.setTimeout(500);
    socket.on("connect", () => process.exit(0));
    socket.on("error", () => process.exit(1));
    socket.on("timeout", () => process.exit(1));
  ' "$1" "$2" >/dev/null 2>&1
}

http_open() { # port
  node -e '
    const request = require("node:http").get(
      { host: "127.0.0.1", port: Number(process.argv[1]), path: "/auth/login", timeout: 2000 },
      (res) => {
        res.resume();
        process.exit(0);
      },
    );
    request.on("error", () => process.exit(1));
    request.on("timeout", () => process.exit(1));
  ' "$1" >/dev/null 2>&1
}

wait_for() { # command — up to 20s
  tries=0
  while [ "$tries" -lt 40 ]; do
    if "$@"; then return 0; fi
    sleep 0.5
    tries=$((tries + 1))
  done
  return 1
}

pg_ready() { tcp_open "$PG_HOST" "$PG_PORT"; }
redis_ready() { tcp_open "$REDIS_HOST" "$REDIS_PORT"; }

# ─── This checkout's identity ────────────────────────────────────────────────

KEY="$(basename "$PWD" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9' '_')"
KEY="${KEY%_}"
KEY="$(printf '%s' "$KEY" | cut -c1-40)"
[ -n "$KEY" ] || KEY="checkout"

# "saale_" plus the key still fits a Postgres identifier (63 characters).
DB_NAME="saale_${KEY}"

# One Redis index per checkout, out of the 16 a default server has. Index 0
# stays with whatever a deployed instance would use.
KEY_HASH="$(printf '%s' "$KEY" | cksum | cut -d' ' -f1)"
REDIS_DB=$((KEY_HASH % 15 + 1))

env_value() { # key — read from .env without sourcing it
  [ -f .env ] || return 0
  value="$(sed -n "s/^$1=//p" .env | tail -1)"
  value="${value%\"}"
  value="${value#\"}"
  printf '%s' "$value"
}

# ─── Services ────────────────────────────────────────────────────────────────

ensure_services() {
  if ! pg_ready || ! redis_ready; then
    if ! command -v psql >/dev/null 2>&1 || ! command -v redis-server >/dev/null 2>&1; then
      say "Installing PostgreSQL and Redis"
      as_root apt-get update -qq >/dev/null 2>&1 || true
      as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y postgresql redis-server \
        >/dev/null 2>&1 || true
    fi
  fi

  if ! pg_ready; then
    say "Starting PostgreSQL"
    as_root service postgresql start >/dev/null 2>&1 || true
    wait_for pg_ready || true
    # No init script, or a cluster it does not know about.
    for version in $(ls /etc/postgresql 2>/dev/null | sort -rn); do
      pg_ready && break
      as_root pg_ctlcluster "$version" main start >/dev/null 2>&1 || true
      wait_for pg_ready || true
    done
  fi
  pg_ready || die "PostgreSQL is not listening on $PG_HOST:$PG_PORT and would not start"

  if ! redis_ready; then
    say "Starting Redis"
    as_root service redis-server start >/dev/null 2>&1 || true
    wait_for redis_ready || true
    if ! redis_ready && command -v redis-server >/dev/null 2>&1; then
      as_root redis-server --daemonize yes --bind "$REDIS_HOST" --port "$REDIS_PORT" \
        >/dev/null 2>&1 || true
      wait_for redis_ready || true
    fi
  fi
  redis_ready || die "Redis is not listening on $REDIS_HOST:$REDIS_PORT and would not start"
}

# ─── Database ────────────────────────────────────────────────────────────────

ensure_database() {
  [ -z "${DATABASE_URL:-}" ] || return 0

  url="postgresql://$PG_USER:$PG_PASSWORD@$PG_HOST:$PG_PORT/$DB_NAME"
  psql -X -q -tA "$url" -c "SELECT 1" >/dev/null 2>&1 && return 0

  # A socket in /var/run/postgresql can be a leftover from a cluster that is not
  # running, so ask the superuser over TCP first.
  super=""
  if psql -X -q -tA -v ON_ERROR_STOP=1 -h "$PG_HOST" -p "$PG_PORT" -U postgres -d postgres \
    -c "SELECT 1" >/dev/null 2>&1; then
    super="tcp"
  elif [ "$(id -u)" -eq 0 ] &&
    runuser -u postgres -- psql -X -q -tA -v ON_ERROR_STOP=1 -c "SELECT 1" >/dev/null 2>&1; then
    super="runuser"
  fi
  [ -n "$super" ] ||
    die "No PostgreSQL superuser answers on $PG_HOST:$PG_PORT, so $DB_NAME cannot be created"

  psql_super() { # psql arguments
    if [ "$super" = "tcp" ]; then
      psql -X -q -tA -v ON_ERROR_STOP=1 -h "$PG_HOST" -p "$PG_PORT" -U postgres -d postgres "$@"
    else
      runuser -u postgres -- psql -X -q -tA -v ON_ERROR_STOP=1 "$@"
    fi
  }

  if [ "$(psql_super -c "SELECT 1 FROM pg_roles WHERE rolname = '$PG_USER'")" != "1" ]; then
    say "Creating the $PG_USER role"
    psql_super -c "CREATE ROLE $PG_USER LOGIN PASSWORD '$PG_PASSWORD' CREATEDB" >/dev/null
  fi

  if [ "$(psql_super -c "SELECT 1 FROM pg_database WHERE datname = '$DB_NAME'")" != "1" ]; then
    say "Creating the $DB_NAME database"
    psql_super -c "CREATE DATABASE $DB_NAME OWNER $PG_USER" >/dev/null
  fi
}

# ─── Port ────────────────────────────────────────────────────────────────────

# A stable offset per checkout. The port a checkout already uses is kept, so a
# URL does not move between runs.
pick_port() {
  base=$((3630 + KEY_HASH % 60))
  for candidate in "$base" 3630; do
    if ! tcp_open 127.0.0.1 "$candidate"; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  candidate=$((base + 1))
  while [ "$candidate" -lt $((base + 60)) ]; do
    if ! tcp_open 127.0.0.1 "$candidate"; then
      printf '%s' "$candidate"
      return 0
    fi
    candidate=$((candidate + 1))
  done
  die "No free port near $base"
}

# The port this checkout uses: an override, the recorded one, or the default.
configured_port() {
  port="${PORT:-$(env_value PORT)}"
  printf '%s' "${port:-3630}"
}

# ─── .env ────────────────────────────────────────────────────────────────────

# Only this block belongs to the checkout, so only this block is rewritten: the
# secrets and anything else in .env stay as they are. A checkout that the older
# coder setup script wrote still carries its block of the same values, which is
# dropped here rather than left to win the parse.
MARKER_START="# >>> checkout env (scripts/dev.sh) >>>"
MARKER_END="# <<< checkout env (scripts/dev.sh) <<<"
LEGACY_START="# >>> checkout env (coder setup) >>>"
LEGACY_END="# <<< checkout env (coder setup) <<<"

write_env_block() {
  if [ ! -f .env ]; then
    say "Creating .env"
    if [ -f .env.example ]; then
      grep -Ev '^(PORT|BETTER_AUTH_URL|DATABASE_URL|REDIS_URL)=' .env.example >.env
    else
      : >.env
    fi
  fi

  {
    awk -v s="$MARKER_START" -v e="$MARKER_END" -v s2="$LEGACY_START" -v e2="$LEGACY_END" '
      $0 == s || $0 == s2 { skipping = 1; next }
      $0 == e || $0 == e2 { skipping = 0; next }
      !skipping { print }
    ' .env
    printf '\n%s\n' "$MARKER_START"
    printf '# Rewritten by scripts/dev.sh on every run.\n'
    printf 'PORT=%s\n' "$PORT"
    printf 'BETTER_AUTH_URL="http://localhost:%s"\n' "$PORT"
    printf 'DATABASE_URL="%s"\n' "$DATABASE_URL"
    printf 'REDIS_URL="%s"\n' "$REDIS_URL"
    printf '%s\n' "$MARKER_END"
  } >.env.dev.tmp
  mv .env.dev.tmp .env
}

# Secrets the app refuses to start without: generated once, then kept.
ensure_secret() { # key
  value="$(env_value "$1")"
  case "$value" in
    "" | change-me* | 0123456789abcdef*) ;; # missing, or the example's placeholder
    *)
      [ "${#value}" -ge 32 ] && return 0
      ;;
  esac
  sed -i "/^$1=/d" .env
  printf '%s="%s"\n' "$1" "$(openssl rand -hex 32)" >>.env
}

# ─── Dependencies, schema, account ───────────────────────────────────────────

ensure_dependencies() {
  if [ ! -d node_modules ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
    say "Installing dependencies"
    npm install --no-audit --no-fund
  fi

  say "Generating the Prisma client"
  npx prisma generate >/dev/null

  say "Applying migrations to $DB_NAME"
  npx prisma migrate deploy >/dev/null
}

seed_account() {
  say "Seeding an account"
  node --input-type=module - <<'JS'
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { hashPassword } from "better-auth/crypto";

const email = (process.env.SEED_EMAIL || "dev@saale.local").toLowerCase();
const username = (process.env.SEED_USERNAME || "dev").toLowerCase();
const password = process.env.SEED_PASSWORD || "saale-dev-password";
const name = process.env.SEED_NAME || username;

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

try {
  const existing = await prisma.user.findFirst({ where: { OR: [{ email }, { username }] } });
  if (existing) {
    console.log(`Account already there: ${existing.email} (username ${existing.username})`);
  } else {
    // The first account in an empty database is the admin, as the first
    // sign-up is.
    const role = (await prisma.user.count()) === 0 ? "admin" : "user";
    const user = await prisma.user.create({
      data: { email, username, name, emailVerified: true, role },
    });
    await prisma.account.create({
      data: {
        userId: user.id,
        accountId: user.id,
        providerId: "credential",
        password: await hashPassword(password),
      },
    });
    console.log(`Seeded ${role}: ${username} / ${password}  (or ${email})`);
  }
} finally {
  await prisma.$disconnect();
}
JS
}

# ─── The app ─────────────────────────────────────────────────────────────────

start_process() { # name, then the command
  name=$1
  shift
  # Its own session, so stopping it takes the whole tree with it: turbopack and
  # tsx --watch both keep children.
  setsid nohup "$@" >"$DEV_DIR/$name.log" 2>&1 </dev/null &
  echo $! >"$DEV_DIR/$name.pid"
}

stop_process() { # name
  pid_file="$DEV_DIR/$1.pid"
  [ -f "$pid_file" ] || return 0
  pid="$(cat "$pid_file")"
  kill -TERM "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  rm -f "$pid_file"
}

process_running() { # name
  pid_file="$DEV_DIR/$1.pid"
  [ -f "$pid_file" ] && kill -0 "$(cat "$pid_file")" 2>/dev/null
}

start_app() {
  ensure_services
  PORT="$(configured_port)"
  export PORT
  mkdir -p "$DEV_DIR"

  if http_open "$PORT"; then
    say "Already answering on $PORT"
    return 0
  fi
  tcp_open 127.0.0.1 "$PORT" &&
    die "Port $PORT is taken by something else. Free it, or run setup to pick another port"

  [ -f .env ] || die "No .env in this checkout. Run: sh scripts/dev.sh setup"

  say "Starting the dev server on $PORT"
  start_process app npx next dev --turbopack --port "$PORT" --hostname 0.0.0.0

  say "Starting the queue worker"
  start_process worker env HOSTNAME=0.0.0.0 npx tsx --watch src/lib/queue/worker.ts

  if wait_for app_ready; then
    say "Ready"
  else
    warn "The dev server has not answered yet. Check: sh scripts/dev.sh logs"
  fi
  report
}

app_ready() { http_open "$(configured_port)"; }

stop_app() {
  stop_process app
  stop_process worker
  PORT="$(configured_port)"
  tries=0
  while [ "$tries" -lt 20 ]; do
    http_open "$PORT" || break
    sleep 0.5
    tries=$((tries + 1))
  done
  if http_open "$PORT"; then
    warn "Something still answers on $PORT that this script did not start"
  else
    say "Stopped"
  fi
}

report() {
  printf '  app       http://localhost:%s\n' "$PORT"
  printf '  login     dev / saale-dev-password  (or dev@saale.local)\n'
  printf '  database  %s\n' "$(env_value DATABASE_URL)"
  printf '  redis     %s\n' "$(env_value REDIS_URL)"
  printf '  logs      sh scripts/dev.sh logs\n'
}

status_line() { # label, check, and the argument the check takes
  if [ -n "${3:-}" ]; then
    state=$("$2" "$3" && echo up || echo down)
  else
    state=$("$2" && echo up || echo down)
  fi
  printf '  %-9s %s\n' "$1" "$state"
}

status() {
  status_line postgres pg_ready
  status_line redis redis_ready
  status_line app app_ready
  status_line worker process_running worker
  printf '  port      %s\n' "$(configured_port)"
}

logs() {
  mkdir -p "$DEV_DIR"
  [ -f "$APP_LOG" ] || : >"$APP_LOG"
  [ -f "$WORKER_LOG" ] || : >"$WORKER_LOG"
  tail -n 40 -f "$APP_LOG" "$WORKER_LOG"
}

setup() {
  ensure_services
  ensure_database
  PORT="$(configured_port)"
  if tcp_open 127.0.0.1 "$PORT"; then
    PORT="$(pick_port)"
  fi
  export PORT
  DATABASE_URL="${DATABASE_URL:-postgresql://$PG_USER:$PG_PASSWORD@$PG_HOST:$PG_PORT/$DB_NAME}"
  REDIS_URL="${REDIS_URL:-redis://$REDIS_HOST:$REDIS_PORT/$REDIS_DB}"
  export DATABASE_URL REDIS_URL

  write_env_block
  for key in BETTER_AUTH_SECRET ENCRYPTION_KEY SANDBOX_API_KEY WORKER_API_KEY; do
    ensure_secret "$key"
  done

  ensure_dependencies
  seed_account

  pg_ready || die "PostgreSQL stopped during setup"
  redis_ready || die "Redis stopped during setup"

  say "Ready to start"
  printf '  start     sh scripts/dev.sh start\n'
  printf '  app       http://localhost:%s\n' "$PORT"
  printf '  login     dev / saale-dev-password  (or dev@saale.local)\n'
  printf '  database  %s\n' "$DATABASE_URL"
  printf '  redis     %s\n' "$REDIS_URL"
}

usage() {
  cat <<'TXT'
usage: sh scripts/dev.sh <command>

  setup     postgres, redis, this checkout's database and port, .env,
            dependencies, the schema and an account. Safe to re-run.
  start     dev server and queue worker, in the background.
  stop      both of them, and whatever they spawned.
  restart   stop, then start.
  status    what is up, and on which port.
  logs      follow both logs.
TXT
}

case "${1:-}" in
  setup) setup ;;
  start) start_app ;;
  stop) stop_app ;;
  restart)
    stop_app
    start_app
    ;;
  status) status ;;
  logs) logs ;;
  *) usage && exit 1 ;;
esac
