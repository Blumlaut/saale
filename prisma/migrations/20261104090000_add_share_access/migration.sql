-- Who may open a share link: "public" (anyone holding it) or "account".
-- Existing shares stay open, so the default is the current behaviour.

ALTER TABLE "ChatSession" ADD COLUMN IF NOT EXISTS "shareAccess" TEXT NOT NULL DEFAULT 'public';
