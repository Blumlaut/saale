-- Watcher delivery: where a fire goes, and the chats a coder fire opens.

-- AlterTable
ALTER TABLE "ChatSession" ADD COLUMN IF NOT EXISTS "origin" TEXT NOT NULL DEFAULT 'user',
ADD COLUMN IF NOT EXISTS "originId" TEXT,
ADD COLUMN IF NOT EXISTS "worktreeBranch" TEXT;

-- AlterTable
ALTER TABLE "ScriptWatcher" ADD COLUMN IF NOT EXISTS "deliver" TEXT NOT NULL DEFAULT 'chat',
ADD COLUMN IF NOT EXISTS "projectId" TEXT,
ADD COLUMN IF NOT EXISTS "retentionMinutes" INTEGER NOT NULL DEFAULT 1440,
ADD COLUMN IF NOT EXISTS "stickySessionId" TEXT,
ADD COLUMN IF NOT EXISTS "worktreeMode" TEXT NOT NULL DEFAULT 'per-fire';

-- AlterTable
ALTER TABLE "ScriptWatcherTick" ADD COLUMN IF NOT EXISTS "sessionId" TEXT,
ADD COLUMN IF NOT EXISTS "toolNames" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- Backfill: a watcher with no conversation was reporting into a standalone run
-- nothing was delivered from, which is what `silent` now says outright.
UPDATE "ScriptWatcher" SET "deliver" = 'silent' WHERE "sessionId" IS NULL;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ChatSession_origin_originId_idx" ON "ChatSession"("origin", "originId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ScriptWatcher_projectId_idx" ON "ScriptWatcher"("projectId");

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ScriptWatcher_projectId_fkey'
  ) THEN
    ALTER TABLE "ScriptWatcher" ADD CONSTRAINT "ScriptWatcher_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "CoderProject"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
