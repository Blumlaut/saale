-- The pull request a chat's branch is on, as `gh` last reported it, so the
-- coder landing page can draw a badge without asking the forge per row.
ALTER TABLE "ChatSession" ADD COLUMN IF NOT EXISTS "prNumber" INTEGER;
ALTER TABLE "ChatSession" ADD COLUMN IF NOT EXISTS "prState" VARCHAR(16);
ALTER TABLE "ChatSession" ADD COLUMN IF NOT EXISTS "prDraft" BOOLEAN;
ALTER TABLE "ChatSession" ADD COLUMN IF NOT EXISTS "prUrl" VARCHAR(2048);
ALTER TABLE "ChatSession" ADD COLUMN IF NOT EXISTS "prCheckedAt" TIMESTAMP(3);
