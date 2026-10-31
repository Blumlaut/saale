-- AlterTable
ALTER TABLE "ChatMessage" ADD COLUMN IF NOT EXISTS "clientDeviceId" TEXT;

-- AlterTable
ALTER TABLE "ChatSession" DROP COLUMN IF EXISTS "clientDeviceId";
