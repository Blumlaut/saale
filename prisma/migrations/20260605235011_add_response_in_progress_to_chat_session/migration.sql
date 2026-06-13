-- DropIndex
DROP INDEX IF EXISTS "idx_chat_session_title_trgm";

-- DropIndex
DROP INDEX IF EXISTS "idx_email_body_preview_trgm";

-- DropIndex
DROP INDEX IF EXISTS "idx_email_subject_trgm";

-- AlterTable
ALTER TABLE "ChatSession" ADD COLUMN     "responseInProgress" BOOLEAN NOT NULL DEFAULT false;
