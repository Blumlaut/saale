-- The conversation a watcher was created from, so a script that sends a
-- message acts as that chat instead of a conversation it has no link to.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ScriptWatcher' AND column_name = 'originSessionId') THEN
    ALTER TABLE "ScriptWatcher" ADD COLUMN "originSessionId" TEXT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "ScriptWatcher_originSessionId_idx" ON "ScriptWatcher"("originSessionId");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ScriptWatcher_originSessionId_fkey') THEN
    ALTER TABLE "ScriptWatcher" ADD CONSTRAINT "ScriptWatcher_originSessionId_fkey" FOREIGN KEY ("originSessionId") REFERENCES "ChatSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
