-- DropIndex
DROP INDEX IF EXISTS "idx_chat_session_title_trgm";
DROP INDEX IF EXISTS "idx_email_body_preview_trgm";
DROP INDEX IF EXISTS "idx_email_subject_trgm";

-- AlterTable (idempotent)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='ChatSession' AND column_name='responseInProgress') THEN
    ALTER TABLE "ChatSession" ADD COLUMN "responseInProgress" BOOLEAN NOT NULL DEFAULT false;
  END IF;
END $$;
