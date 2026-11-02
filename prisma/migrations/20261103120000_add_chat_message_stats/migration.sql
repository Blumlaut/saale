-- Per-turn cost and context breakdown for an assistant message.

ALTER TABLE "ChatMessage" ADD COLUMN IF NOT EXISTS "stats" JSONB;
