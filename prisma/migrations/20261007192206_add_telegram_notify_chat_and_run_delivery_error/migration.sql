-- AlterTable
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'AgentRun' AND column_name = 'deliveryError') THEN
    ALTER TABLE "AgentRun" ADD COLUMN "deliveryError" TEXT;
  END IF;
END $$;

-- AlterTable
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'TelegramAccount' AND column_name = 'notifyChatId') THEN
    ALTER TABLE "TelegramAccount" ADD COLUMN "notifyChatId" BIGINT;
  END IF;
END $$;
