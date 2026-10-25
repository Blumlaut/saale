-- Where a chat title came from, so the title job can tell a generated title
-- from one the user wrote.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'ChatSession' AND column_name = 'titleSource'
  ) THEN
    ALTER TABLE "ChatSession" ADD COLUMN "titleSource" TEXT NOT NULL DEFAULT 'default';
  END IF;
END $$;

-- Existing rows: keep what the job skipped before this column existed, titles
-- that were neither "New Chat" nor a truncated prompt.
UPDATE "ChatSession" SET "titleSource" = 'user'
WHERE "titleSource" = 'default' AND "title" <> 'New Chat' AND "title" NOT LIKE '%...';
