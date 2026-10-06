-- Username login handle (better-auth username plugin).
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "username" TEXT;

-- Backfill from the existing display name: lowercase, non-handle characters
-- become dashes, and the email local part is the fallback when a name is
-- missing or too short to be a username (see src/lib/auth/username.ts).
DO $$
DECLARE
  target RECORD;
  base TEXT;
  candidate TEXT;
  suffix INTEGER;
BEGIN
  FOR target IN
    SELECT id, name, email FROM "user" WHERE "username" IS NULL ORDER BY "createdAt", id
  LOOP
    base := lower(coalesce(target.name, ''));
    base := regexp_replace(base, '[^a-z0-9._-]+', '-', 'g');
    base := regexp_replace(base, '[._-]{2,}', '-', 'g');
    base := trim(both '-._' FROM base);

    IF length(base) < 3 THEN
      base := lower(split_part(coalesce(target.email, ''), '@', 1));
      base := regexp_replace(base, '[^a-z0-9._-]+', '-', 'g');
      base := regexp_replace(base, '[._-]{2,}', '-', 'g');
      base := trim(both '-._' FROM base);
    END IF;

    IF length(base) < 3 THEN
      base := 'user-' || lower(substr(target.id, 1, 12));
    END IF;

    base := trim(both '-._' FROM left(base, 30));

    -- Same handle twice: suffix it until it is free (already-assigned handles
    -- included, so the unique index below cannot fail).
    candidate := base;
    suffix := 1;
    WHILE EXISTS (SELECT 1 FROM "user" WHERE "username" = candidate) LOOP
      suffix := suffix + 1;
      candidate := trim(both '-._' FROM left(base, 30 - length(suffix::text) - 1)) || '-' || suffix;
    END LOOP;

    UPDATE "user" SET "username" = candidate WHERE id = target.id;
  END LOOP;
END $$;

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "user_username_key" ON "user"("username");
