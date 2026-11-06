-- A prompt that has not settled yet. The row lives from the moment a chat
-- claims its prompt until the run settles, so a row at boot is a run a restart
-- killed.

CREATE TABLE IF NOT EXISTS "ChatRun" (
    "sessionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatRun_pkey" PRIMARY KEY ("sessionId")
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ChatRun_sessionId_fkey') THEN
    ALTER TABLE "ChatRun" ADD CONSTRAINT "ChatRun_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ChatSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
