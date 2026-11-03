-- Where a server connects: a chat, a coder chat, or both. Existing rows
-- connect everywhere, which is what they did before the switch existed.
ALTER TABLE "McpServer" ADD COLUMN IF NOT EXISTS "chatEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "McpServer" ADD COLUMN IF NOT EXISTS "coderEnabled" BOOLEAN NOT NULL DEFAULT true;
