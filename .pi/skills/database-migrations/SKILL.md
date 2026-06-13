---
name: database-migrations
description: Prisma migration workflow for Saale. MUST be consulted before writing any migration or making database changes — adding fields, creating models, dropping columns, enabling extensions, creating indexes, or any other DB modification. Covers the full workflow from schema edit to deploy.
---

# Database Migrations

Saale uses Prisma's native incremental migration system. This is the official, well-tested approach — no custom scripts, no workarounds.

## How It Works

1. **`prisma/schema.prisma`** — the single source of truth for the database schema.
2. **`prisma/migrations/`** — incremental migration files, each representing one schema change. Applied in order, tracked in `_prisma_migrations` table.
3. **`npm run db:migrate`** — creates a new migration from schema changes and applies it locally.
4. **`prisma migrate deploy`** — runs in Docker entrypoint, applies any pending migrations on the remote DB.

## Workflow

### Adding a New Field

```bash
# 1. Edit the schema
#    prisma/schema.prisma — add the field to the model

# 2. Create and apply the migration
npm run db:migrate
# This creates prisma/migrations/<timestamp>_add_<field>/migration.sql

# 3. Review the generated SQL
cat prisma/migrations/*/migration.sql  # check the last one

# 4. Regenerate the Prisma client
npx prisma generate

# 5. Verify
npx prisma migrate status  # should show "up to date"

# 6. Commit together
git add prisma/schema.prisma prisma/migrations/
git commit -m "add <field> to <model>"
```

### Local Development

After changing the schema:

```bash
npm run db:migrate    # creates + applies migration
npx prisma generate   # regenerates client types
```

The Docker container will pick up new migrations on restart — `prisma migrate deploy` runs in the entrypoint.

### Resetting Local DB

If you need a clean slate locally:

```bash
# Drop and recreate via the host's PostgreSQL
sudo -u postgres dropdb saale
sudo -u postgres createdb -O saale saale

# Re-apply all migrations
npx prisma migrate deploy
```

Or via Docker (when containers are running):

```bash
sudo docker compose exec postgres dropdb --if-exists -U saale saale
sudo docker compose exec postgres createdb -U saale saale
sudo docker compose up -d --force-recreate web  # migrate deploy runs automatically
```

## Rules

1. **`prisma/schema.prisma` is the only place you define schema changes.** Never write raw SQL to alter the database.
2. **Never edit an applied migration file.** This changes its hash and causes "migration out of sync" errors. If a migration is wrong, revert the schema change and create a new one.
3. **Never delete migration files.** They represent the authoritative history.
4. **Always commit migration files immediately.** A migration that exists locally but not in git will cause the remote deploy to have no migrations to apply.
5. **Always regenerate the Prisma client** (`npx prisma generate`) after schema changes.
6. **Test before committing.** Verify `npx prisma migrate status` shows no pending migrations.
7. **Review generated SQL.** Especially for destructive changes (DROP COLUMN, DROP TABLE).
8. **Every migration MUST be automatically runnable on deploy.** `prisma migrate deploy` is the only mechanism that applies migrations on the remote server. Never execute migration SQL manually (e.g. `psql -f`, `docker exec psql -c`) — the remote has no way to replay it. If a migration was manually executed, register it with `npx prisma migrate resolve --applied <name>` so Prisma tracks it correctly.

## Failure-Safe Migrations

**Every migration must be idempotent enough to survive a failed partial execution and retry.**

When a migration fails mid-way, Prisma marks it as "failed" and refuses to apply new migrations. On retry (after fixing), the same migration SQL runs again — any statements that already succeeded will fail on re-execution.

### Always Use

```sql
-- ✅ Safe — won't fail if index/column/table doesn't exist
DROP INDEX IF EXISTS "idx_name";
DROP TABLE IF EXISTS "TableName";
ALTER TABLE "MyTable" DROP COLUMN IF EXISTS "oldColumn";

-- ✅ Safe — won't fail if index already exists
CREATE INDEX IF NOT EXISTS idx_name ON "MyTable" (col);
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ✅ Safe — conditional column add
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='MyTable' AND column_name='newCol') THEN
    ALTER TABLE "MyTable" ADD COLUMN "newCol" TEXT;
  END IF;
END $$;
```

### Never Use

```sql
-- ❌ Fails if index doesn't exist
DROP INDEX "idx_name";

-- ❌ Fails if column doesn't exist
ALTER TABLE "MyTable" DROP COLUMN "oldColumn";

-- ❌ Fails if index already exists
CREATE INDEX idx_name ON "MyTable" (col);

-- ❌ Fails if column already exists
ALTER TABLE "MyTable" ADD COLUMN "newCol" TEXT;
```

### Prisma-Generated Migrations

Prisma's auto-generated migrations often use `DROP INDEX` without `IF EXISTS`. **Always review and add `IF EXISTS`** before committing, especially when:
- Dropping indexes created by a previous migration in the same deploy
- Dropping columns that might have been manually removed
- Adding columns that might exist from a partial previous run

### Casting to a Shorter Type

When changing a column from `TEXT` to `VARCHAR(N)`, existing data may exceed the new limit. PostgreSQL will reject the cast with `value too long for type character varying(N)`.

**Always truncate existing data before the type change:**

```sql
-- ✅ Safe — truncate first, then cast
UPDATE "MyTable" SET "myColumn" = LEFT("myColumn", 50) WHERE CHAR_LENGTH("myColumn") > 50;
ALTER TABLE "MyTable" ALTER COLUMN "myColumn" TYPE VARCHAR(50);

-- ❌ Fails if any row has data > 50 chars
ALTER TABLE "MyTable" ALTER COLUMN "myColumn" TYPE VARCHAR(50);
```

This is especially critical for production databases where existing rows may have long values. Prisma's auto-generated migrations never add the `UPDATE` step — you must add it manually.

## Dropping Columns or Tables

Dropping is allowed — it's a normal part of schema evolution. The key is to do it deliberately through migrations, not accidentally.

### When Dropping Is Fine

- Debug/test fields that served their purpose
- Columns replaced by a new column (add new → backfill → drop old in separate migration)
- Tables that are truly obsolete with no remaining data needs

### When to Be Careful

- Columns with data needed at runtime during deployment (split into steps)
- Foreign key columns (drop the constraint first, then the column)
- Indexed columns (the index is dropped automatically with the column)

### Example: Safe Column Replacement

```prisma
// Step 1: Add new column (nullable)
model User {
  // ...
  oldName    String?
  displayName String?
}

// Deploy, backfill data via script or app code

// Step 2: Make new column required, drop old
model User {
  // ...
  displayName String
}
```

Each step is a separate migration, deployed separately.

## What NOT to Do

```bash
# ❌ BAD — manual SQL (remote deploy can't replay this)
docker exec postgres psql -c "ALTER TABLE ..."
psql -f migration.sql

# ❌ BAD — prisma db push (bypasses migrations, can drop data)
npx prisma db push --accept-data-loss

# ❌ BAD — editing a migration after it was applied
nano prisma/migrations/20240101_something/migration.sql

# ❌ BAD — deleting a migration
rm prisma/migrations/20240101_something/

# ❌ BAD — forgetting to commit the migration file
git add prisma/schema.prisma
git commit -m "add field"  # migration file not included!
```

## Non-Schema Migrations (Extensions, Custom Indexes)

Some database changes can't be expressed in Prisma's schema DSL — extensions (`pg_trgm`, `pgvector`), GIN/BRIN indexes, or custom functions. These still need tracked migrations:

1. **Create the migration directory manually** with a descriptive name:
   ```bash
   mkdir prisma/migrations/enable_pg_trgm
   ```
2. **Write the `migration.sql`** inside it. Use `IF NOT EXISTS` / `DROP ... IF EXISTS` for idempotency:
   ```sql
   CREATE EXTENSION IF NOT EXISTS pg_trgm;
   CREATE INDEX IF NOT EXISTS idx_x_trgm ON "MyModel" USING gin ("myField" gin_trgm_ops);
   ```
3. **Register it as applied** (since Prisma can't auto-apply non-schema migrations):
   ```bash
   npx prisma migrate resolve --applied enable_pg_trgm
   ```
   This records the migration in `_prisma_migrations` without re-running the SQL.
4. **On remote deploy**, `prisma migrate deploy` sees the migration file is not in the remote `_prisma_migrations` and applies it automatically.

## Troubleshooting

### "Migration was modified after it was applied"

The migration file was edited after being applied, changing its hash. Fix:
1. Check out the original migration from git: `git checkout -- prisma/migrations/<name>/migration.sql`
2. If the original is lost, reset the DB and re-apply: `npx prisma migrate reset`

### "Migrations from the database are not found locally"

The DB has migrations that don't exist in the local `prisma/migrations/` folder. This happens when migration files weren't committed. Fix:
1. Pull the latest migrations from git: `git pull`
2. If they were never committed, the migration history is corrupted. Reset: `npx prisma migrate reset`

### "Database schema is up to date" but fields are missing

The migration was applied but the Prisma client types are stale. Fix:
```bash
npx prisma generate
```

### Remote deploy says "no migrations to apply"

The migration file wasn't committed/pushed. Fix:
1. Check `git status` — migration file should be committed
2. Push: `git push`
3. Redeploy

### "migrate found failed migrations in the target database"

A migration started but failed (partial execution). Prisma blocks new migrations until the failed one is resolved.

**Fix (on the remote server / via docker exec):**

```bash
# 1. Mark the failed migration as rolled back (undone)
npx prisma migrate resolve --rolled-back <migration_name>

# 2. Now the migration can be re-applied (it will run again from scratch)
npx prisma migrate deploy
```

The migration SQL must be idempotent (use `IF EXISTS` / `IF NOT EXISTS`) so it doesn't fail on retry. See "Failure-Safe Migrations" above.
