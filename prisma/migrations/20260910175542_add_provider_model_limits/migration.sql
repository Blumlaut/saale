-- AlterTable
ALTER TABLE "provider_api_key" ADD COLUMN IF NOT EXISTS "contextWindow" INTEGER,
ADD COLUMN IF NOT EXISTS "maxOutputTokens" INTEGER;
