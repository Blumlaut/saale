-- Add sharing fields to ChatSession

ALTER TABLE "ChatSession" ADD COLUMN IF NOT EXISTS "shared" BOOLEAN DEFAULT false;
ALTER TABLE "ChatSession" ADD COLUMN IF NOT EXISTS "shareToken" TEXT;
ALTER TABLE "ChatSession" ADD COLUMN IF NOT EXISTS "sourceShareToken" TEXT;

-- Unique constraint on shareToken (only non-null values)
CREATE UNIQUE INDEX IF NOT EXISTS "ChatSession_shareToken_key" ON "ChatSession" ("shareToken") WHERE "shareToken" IS NOT NULL;

-- Index for fast token lookups
CREATE INDEX IF NOT EXISTS "ChatSession_shareToken_idx" ON "ChatSession" ("shareToken") WHERE "shareToken" IS NOT NULL;
