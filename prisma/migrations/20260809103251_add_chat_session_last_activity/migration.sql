-- Add lastActivityAt to ChatSession.
--
-- Unlike updatedAt (a Prisma @updatedAt that bumps on ANY row write — tool
-- state, background jobs, etc.), lastActivityAt is only advanced by real chat
-- activity (messages sent/saved, title edited). The UI sorts and displays
-- this field, so background activity must never move a chat to the top.
--
-- Idempotent + failure-safe: add the column as nullable, backfill existing
-- rows from updatedAt (so old chats keep their real last-activity time
-- instead of all becoming "today"), then lock it to NOT NULL with a default.

-- 1. Add the column as nullable if it doesn't exist yet.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'ChatSession' AND column_name = 'lastActivityAt'
  ) THEN
    ALTER TABLE "ChatSession" ADD COLUMN "lastActivityAt" TIMESTAMP(3);
  END IF;
END $$;

-- 2. Backfill from updatedAt (best available approximation of last real
--    activity before this column existed). No-op on retry.
UPDATE "ChatSession"
SET "lastActivityAt" = "updatedAt"
WHERE "lastActivityAt" IS NULL;

-- 3. NOT NULL + default now() — matches the Prisma schema. Idempotent on retry.
ALTER TABLE "ChatSession" ALTER COLUMN "lastActivityAt" SET DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "ChatSession" ALTER COLUMN "lastActivityAt" SET NOT NULL;
