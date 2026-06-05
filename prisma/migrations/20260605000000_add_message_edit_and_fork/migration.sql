-- Add editedAt to ChatMessage for tracking when user messages are edited
ALTER TABLE "ChatMessage" ADD COLUMN "editedAt" DateTime;

-- Add fork tracking to ChatSession
ALTER TABLE "ChatSession" ADD COLUMN "forkedFromSessionId" String;
ALTER TABLE "ChatSession" ADD COLUMN "forkedAtMessageId" String;
