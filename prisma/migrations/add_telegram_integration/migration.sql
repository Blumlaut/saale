-- Create TelegramAccount table (idempotent)
CREATE TABLE IF NOT EXISTS "TelegramAccount" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "encryptedToken" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "botId" INTEGER,
    "botUsername" TEXT,
    "webhookSecret" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TelegramAccount_pkey" PRIMARY KEY ("id")
);

-- Create TelegramWhitelist table (idempotent)
CREATE TABLE IF NOT EXISTS "TelegramWhitelist" (
    "id" TEXT NOT NULL,
    "telegramAccountId" TEXT NOT NULL,
    "telegramUserId" BIGINT NOT NULL,
    "displayName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TelegramWhitelist_pkey" PRIMARY KEY ("id")
);

-- Create TelegramChat table (idempotent)
CREATE TABLE IF NOT EXISTS "TelegramChat" (
    "id" TEXT NOT NULL,
    "telegramAccountId" TEXT NOT NULL,
    "telegramChatId" BIGINT NOT NULL,
    "chatType" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "lastMessageId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TelegramChat_pkey" PRIMARY KEY ("id")
);

-- Indexes (idempotent via IF NOT EXISTS)
CREATE UNIQUE INDEX IF NOT EXISTS "TelegramAccount_userId_key" ON "TelegramAccount"("userId");
CREATE INDEX IF NOT EXISTS "TelegramAccount_webhookSecret_idx" ON "TelegramAccount"("webhookSecret");
CREATE INDEX IF NOT EXISTS "TelegramWhitelist_telegramAccountId_idx" ON "TelegramWhitelist"("telegramAccountId");
CREATE UNIQUE INDEX IF NOT EXISTS "TelegramWhitelist_telegramAccountId_telegramUserId_key" ON "TelegramWhitelist"("telegramAccountId", "telegramUserId");
CREATE INDEX IF NOT EXISTS "TelegramChat_sessionId_idx" ON "TelegramChat"("sessionId");
CREATE UNIQUE INDEX IF NOT EXISTS "TelegramChat_telegramAccountId_telegramChatId_key" ON "TelegramChat"("telegramAccountId", "telegramChatId");

-- Foreign keys (idempotent via DO block)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'TelegramAccount_userId_fkey'
  ) THEN
    ALTER TABLE "TelegramAccount"
      ADD CONSTRAINT "TelegramAccount_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'TelegramWhitelist_telegramAccountId_fkey'
  ) THEN
    ALTER TABLE "TelegramWhitelist"
      ADD CONSTRAINT "TelegramWhitelist_telegramAccountId_fkey"
      FOREIGN KEY ("telegramAccountId") REFERENCES "TelegramAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'TelegramChat_telegramAccountId_fkey'
  ) THEN
    ALTER TABLE "TelegramChat"
      ADD CONSTRAINT "TelegramChat_telegramAccountId_fkey"
      FOREIGN KEY ("telegramAccountId") REFERENCES "TelegramAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
