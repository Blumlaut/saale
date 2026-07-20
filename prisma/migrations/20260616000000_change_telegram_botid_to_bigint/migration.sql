-- Change botId from integer to bigint to support large Telegram bot IDs
ALTER TABLE "TelegramAccount" ALTER COLUMN "botId" TYPE bigint;
