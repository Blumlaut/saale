-- AlterTable
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'AgentDefinition' AND column_name = 'runAt') THEN
    ALTER TABLE "AgentDefinition" ADD COLUMN "runAt" TIMESTAMP(3);
  END IF;
END $$;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AgentDefinition_userId_runAt_idx" ON "AgentDefinition"("userId", "runAt");
