-- AlterTable
ALTER TABLE "ChatMessage" ADD COLUMN     "queuedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "ChatMessage_sessionId_queuedAt_idx" ON "ChatMessage"("sessionId", "queuedAt");
