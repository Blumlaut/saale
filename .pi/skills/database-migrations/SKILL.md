# Database Migrations

Saale uses a **single baseline + auto-diff** migration strategy. This guarantees migrations **never break** — for local dev, remote deployments, or existing users upgrading.

## How It Works

1. **`prisma/schema.prisma`** — the single source of truth for the database schema.
2. **`prisma/migrations/0001_baseline/migration.sql`** — a full SQL dump of the schema. Regenerated on every schema change.
3. **`scripts/migrate.mjs`** — runs at container startup. Diffs the live DB against the target schema and applies only the delta.

### Fresh Install (no tables)

The baseline migration is applied as-is. All tables, indexes, and constraints are created in one transaction.

### Existing Install (upgrade)

`scripts/migrate.mjs` uses `prisma migrate diff --from-url --to-schema` to compute the exact SQL needed to transform the current DB into the target schema. Only the delta is applied — no "out of sync" errors, no dependency on migration history.

## Why This Never Breaks

| Problem | Traditional Prisma | Saale's Approach |
|---|---|---|
| Migration history diverges | ❌ `migrate deploy` fails | ✅ Diffs against live DB state, ignores history |
| Baseline modified after apply | ❌ Hash mismatch, blocks all migrations | ✅ Baseline is regenerated — no hash tracking |
| User skips a version | ❌ Missing migrations error | ✅ Diff computes full delta regardless |
| Manual DB changes | ❌ State divergence | ✅ Diff detects actual state, reconciles |
| Destructive change slips through | ❌ Data loss | ✅ Safety checks block DROP operations |

## Safety Guarantees

The migration script **blocks** these operations:
- `DROP TABLE` — never drop tables
- `DROP COLUMN` — never drop columns
- `DROP INDEX CONCURRENTLY` — never drop indexes

If a schema change requires removing a field, **deprecate it** (keep the column, stop using it in code) rather than dropping it.

## Workflow

### Adding a New Field

```bash
# 1. Edit the schema
#    prisma/schema.prisma — add the field to the model

# 2. Regenerate the baseline migration
npx prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script \
  1> prisma/migrations/0001_baseline/migration.sql 2>/dev/null

# 3. Regenerate the Prisma client
npx prisma generate

# 4. Test locally — rebuild production image and restart
#    (migrate.mjs runs automatically on startup)
BUILD_TARGET=production sudo docker compose up -d --force-recreate web

# 5. Verify the migration ran
sudo docker compose logs web | grep migrate

# 6. Commit everything together
git add prisma/schema.prisma prisma/migrations/0001_baseline/migration.sql
git commit -m "add <field> to <model>"
```

### Local Development

The local Docker setup uses the same migration script. After changing the schema:

```bash
# Regenerate baseline + client
npx prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script \
  1> prisma/migrations/0001_baseline/migration.sql 2>/dev/null
npx prisma generate

# Rebuild production image and restart — migrate.mjs runs automatically
BUILD_TARGET=production sudo docker compose up -d --force-recreate web
```

The diff will detect the new column and add it. No manual SQL, no migration state issues.

### Resetting Local DB

If you need a clean slate locally:

```bash
sudo docker compose down
sudo docker compose run --rm postgres dropdb --if-exists -U saale saale
sudo docker compose run --rm postgres createdb -U saale saale
sudo docker compose up -d web  # baseline applied automatically
```

## Rules

1. **`prisma/schema.prisma` is the only place you define schema changes.** Never write raw SQL to alter the database.
2. **Always regenerate the baseline** after editing the schema. The baseline must match the schema exactly.
3. **Always regenerate the Prisma client** (`npx prisma generate`) after schema changes.
4. **Never drop columns or tables.** Add new fields as nullable, backfill if needed, deprecate old fields.
5. **Never edit migration SQL manually.** Regenerate from the schema.
6. **Test migrations before committing.** Restart the container and verify the logs show "Migration complete."
7. **Commit schema + baseline together.** They are a unit — never commit one without the other.

## What NOT to Do

```bash
# ❌ BAD — manual SQL
docker exec postgres psql -c "ALTER TABLE ..."

# ❌ BAD — prisma db push (can drop data)
npx prisma db push --accept-data-loss

# ❌ BAD — incremental migrations (not used in this project)
npx prisma migrate dev --name add_something

# ❌ BAD — editing migration SQL manually
nano prisma/migrations/0001_baseline/migration.sql

# ❌ BAD — dropping a column because "it's not used"
# Remove the field from schema.prisma → this generates DROP COLUMN → blocked
# Instead: keep the field, stop using it in code
```

## Troubleshooting

### "DATABASE_URL not set"

The migration script reads `DATABASE_URL` from the environment. In Docker, this is set by `docker-compose.yml`. Locally, ensure `.env` has it.

### "Diff contains a destructive operation"

The safety check blocked a DROP operation. To fix:
1. Re-add the dropped field to `prisma/schema.prisma` (make it nullable if needed).
2. Regenerate the baseline.
3. If you truly need to remove data, do it in application code (delete rows) before removing the schema field.

### "Verification failed — database still differs"

The migration applied but the DB doesn't match the schema. This indicates a partial failure. Check the logs for SQL errors. The transaction should have rolled back, so the DB should be in a consistent state. Fix the schema change and retry.

### Local DB out of sync with schema

Reset the local DB (see "Resetting Local DB" above). The baseline will be applied fresh.
