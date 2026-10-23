-- CreateTable
CREATE TABLE IF NOT EXISTS "TelegramChat" (
    "id" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "chatId" BIGINT NOT NULL,
    "title" TEXT,
    "kind" TEXT NOT NULL,
    "memberCount" INTEGER,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "syncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TelegramChat_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "TelegramChat_chatId_key" ON "TelegramChat"("chatId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "TelegramChat_ownerUserId_idx" ON "TelegramChat"("ownerUserId");

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'TelegramChat_botId_fkey') THEN
    ALTER TABLE "TelegramChat" ADD CONSTRAINT "TelegramChat_botId_fkey" FOREIGN KEY ("botId") REFERENCES "TelegramBot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'TelegramChat_ownerUserId_fkey') THEN
    ALTER TABLE "TelegramChat" ADD CONSTRAINT "TelegramChat_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
