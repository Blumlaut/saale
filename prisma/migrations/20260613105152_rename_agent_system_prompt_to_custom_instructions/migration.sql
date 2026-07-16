-- DropIndex (idempotent)
DROP INDEX IF EXISTS "idx_chat_session_title_trgm";
DROP INDEX IF EXISTS "idx_email_body_preview_trgm";
DROP INDEX IF EXISTS "idx_email_subject_trgm";

-- AlterTable (idempotent)
ALTER TABLE "AppSettings" DROP COLUMN IF EXISTS "agentSystemPrompt";

-- Add column only if it doesn't exist (safe for re-runs)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='AppSettings' AND column_name='agentCustomInstructions') THEN
    ALTER TABLE "AppSettings" ADD COLUMN "agentCustomInstructions" TEXT;
  END IF;
END $$;

-- Truncate titles > 50 chars before changing type (prevents "value too long" errors)
UPDATE "ChatSession" SET "title" = LEFT("title", 50) WHERE CHAR_LENGTH("title") > 50;
ALTER TABLE "ChatSession" ALTER COLUMN "title" TYPE VARCHAR(50);

-- Add processingSince if missing
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='ChatSession' AND column_name='processingSince') THEN
    ALTER TABLE "ChatSession" ADD COLUMN "processingSince" TIMESTAMP(3);
  END IF;
END $$;

-- Normalize type (safe no-op if already correct type)
DO $$ BEGIN
  PERFORM 1 FROM information_schema.columns
  WHERE table_name='ChatSession' AND column_name='processingSince'
  AND udt_name != 'timestamp without time zone';
  IF FOUND THEN
    ALTER TABLE "ChatSession" ALTER COLUMN "processingSince" TYPE TIMESTAMP(3);
  END IF;
END $$;
