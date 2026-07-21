-- AlterTable
ALTER TABLE "AgentDefinition" ADD COLUMN     "cronExpression" TEXT,
ADD COLUMN     "lastRunAt" TIMESTAMP(3),
ADD COLUMN     "outputChannel" TEXT,
ADD COLUMN     "outputChannelId" TEXT;

-- AlterTable
ALTER TABLE "AgentRun" ADD COLUMN     "outputChannel" TEXT,
ADD COLUMN     "outputChannelId" TEXT,
ADD COLUMN     "telegramChatId" BIGINT;

-- CreateIndex
CREATE INDEX "AgentDefinition_userId_cronExpression_idx" ON "AgentDefinition"("userId", "cronExpression");
