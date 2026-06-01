-- Add toolConfig column to ChatSession
ALTER TABLE "ChatSession" ADD COLUMN "toolConfig" JSONB;
