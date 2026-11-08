-- A chat the user deleted stays in the lists, greyed, until the removal
-- finishes. `deletingForce` is the answer they already gave when the checkout
-- held work that exists nowhere else.

ALTER TABLE "ChatSession" ADD COLUMN IF NOT EXISTS "deletingAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "deletingForce" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS "ChatSession_deletingAt_idx" ON "ChatSession"("deletingAt");
