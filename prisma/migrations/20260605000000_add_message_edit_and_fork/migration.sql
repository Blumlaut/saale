-- Add editedAt to ChatMessage for tracking when user messages are edited
ALTER TABLE "ChatMessage" ADD COLUMN "editedAt" TIMESTAMPTZ;

-- Add fork tracking to ChatSession
ALTER TABLE "ChatSession" ADD COLUMN "forkedFromSessionId" TEXT;
ALTER TABLE "ChatSession" ADD COLUMN "forkedAtMessageId" TEXT;
