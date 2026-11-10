-- A delete that stops leaves the reason on the chat, so the row can say what
-- happened instead of quietly coming back.

ALTER TABLE "ChatSession" ADD COLUMN IF NOT EXISTS "deleteError" TEXT,
ADD COLUMN IF NOT EXISTS "deleteErrorCode" VARCHAR(32);
