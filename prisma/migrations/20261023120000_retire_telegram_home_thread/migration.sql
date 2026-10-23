-- The link remembers the chat this Telegram conversation is in. It used to point
-- at a dedicated "Telegram Chat" thread; that concept is gone, so the column is
-- renamed rather than re-added.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'TelegramLink' AND column_name = 'lastOutboundSessionId'
  ) THEN
    ALTER TABLE "TelegramLink" RENAME COLUMN "lastOutboundSessionId" TO "activeSessionId";
  END IF;
END $$;

-- sessionId was the home thread pointer. nothing reads it now.
ALTER TABLE "TelegramLink" DROP COLUMN IF EXISTS "sessionId";

DROP INDEX IF EXISTS "TelegramLink_sessionId_idx";
CREATE INDEX IF NOT EXISTS "TelegramLink_activeSessionId_idx" ON "TelegramLink"("activeSessionId");

-- The Telegram Assistant definition bookkept home-thread runs. no code creates
-- or reads it now, and a system-managed row can never be edited or deleted from
-- the UI, so leaving it would strand it there.
DELETE FROM "AgentDefinition" WHERE "name" = 'Telegram Assistant' AND "systemManaged" = true;
