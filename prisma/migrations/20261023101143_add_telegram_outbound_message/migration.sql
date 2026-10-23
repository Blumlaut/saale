-- Every outbound Telegram message, so a reply can find the chat that sent it.
CREATE TABLE IF NOT EXISTS "TelegramOutboundMessage" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "chatId" BIGINT NOT NULL,
    "messageId" BIGINT NOT NULL,
    "sessionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TelegramOutboundMessage_pkey" PRIMARY KEY ("id")
);

-- The chat that last sent a Telegram message: the target of a message that is
-- not a reply.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'TelegramLink' AND column_name = 'lastOutboundSessionId'
  ) THEN
    ALTER TABLE "TelegramLink" ADD COLUMN "lastOutboundSessionId" TEXT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "TelegramOutboundMessage_userId_createdAt_idx" ON "TelegramOutboundMessage"("userId", "createdAt");

CREATE INDEX IF NOT EXISTS "TelegramOutboundMessage_sessionId_idx" ON "TelegramOutboundMessage"("sessionId");

CREATE UNIQUE INDEX IF NOT EXISTS "TelegramOutboundMessage_chatId_messageId_key" ON "TelegramOutboundMessage"("chatId", "messageId");

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'TelegramOutboundMessage_userId_fkey'
  ) THEN
    ALTER TABLE "TelegramOutboundMessage"
      ADD CONSTRAINT "TelegramOutboundMessage_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
