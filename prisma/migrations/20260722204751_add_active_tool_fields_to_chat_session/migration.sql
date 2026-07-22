-- AlterTable
ALTER TABLE "ChatSession" ADD COLUMN     "activeToolArgs" JSONB,
ADD COLUMN     "activeToolName" VARCHAR(200),
ADD COLUMN     "activeToolStartedAt" TIMESTAMP(3);
