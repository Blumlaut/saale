/*
  Warnings:

  - You are about to drop the `TelegramAccount` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `TelegramChat` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `TelegramWhitelist` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE IF EXISTS "TelegramAccount" DROP CONSTRAINT IF EXISTS "TelegramAccount_userId_fkey";

-- DropForeignKey
ALTER TABLE IF EXISTS "TelegramChat" DROP CONSTRAINT IF EXISTS "TelegramChat_telegramAccountId_fkey";

-- DropForeignKey
ALTER TABLE IF EXISTS "TelegramWhitelist" DROP CONSTRAINT IF EXISTS "TelegramWhitelist_telegramAccountId_fkey";

-- DropTable
DROP TABLE IF EXISTS "TelegramAccount";

-- DropTable
DROP TABLE IF EXISTS "TelegramChat";

-- DropTable
DROP TABLE IF EXISTS "TelegramWhitelist";

-- CreateTable
CREATE TABLE IF NOT EXISTS "TelegramBot" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "encryptedToken" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "botId" BIGINT,
    "botUsername" TEXT,
    "webhookSecret" TEXT NOT NULL,
    "updatedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TelegramBot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "TelegramLink" (
    "id" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "telegramUserId" BIGINT NOT NULL,
    "telegramChatId" BIGINT NOT NULL,
    "displayName" TEXT,
    "sessionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TelegramLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "TelegramLinkCode" (
    "id" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TelegramLinkCode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "TelegramLink_userId_key" ON "TelegramLink"("userId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "TelegramLink_telegramUserId_key" ON "TelegramLink"("telegramUserId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "TelegramLink_botId_idx" ON "TelegramLink"("botId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "TelegramLink_sessionId_idx" ON "TelegramLink"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "TelegramLinkCode_codeHash_key" ON "TelegramLinkCode"("codeHash");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "TelegramLinkCode_userId_idx" ON "TelegramLinkCode"("userId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "TelegramLinkCode_expiresAt_idx" ON "TelegramLinkCode"("expiresAt");

-- AddForeignKey
ALTER TABLE "TelegramLink" DROP CONSTRAINT IF EXISTS "TelegramLink_botId_fkey";
ALTER TABLE "TelegramLink" ADD CONSTRAINT "TelegramLink_botId_fkey" FOREIGN KEY ("botId") REFERENCES "TelegramBot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelegramLink" DROP CONSTRAINT IF EXISTS "TelegramLink_userId_fkey";
ALTER TABLE "TelegramLink" ADD CONSTRAINT "TelegramLink_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelegramLinkCode" DROP CONSTRAINT IF EXISTS "TelegramLinkCode_userId_fkey";
ALTER TABLE "TelegramLinkCode" ADD CONSTRAINT "TelegramLinkCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
