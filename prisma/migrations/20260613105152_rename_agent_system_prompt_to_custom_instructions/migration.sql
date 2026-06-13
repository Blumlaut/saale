/*
  Warnings:

  - You are about to drop the column `agentSystemPrompt` on the `AppSettings` table. All the data in the column will be lost.
  - You are about to alter the column `title` on the `ChatSession` table. The data in that column could be lost. The data in that column will be cast from `Text` to `VarChar(50)`.

*/
-- DropIndex
DROP INDEX IF EXISTS "idx_chat_session_title_trgm";

-- DropIndex
DROP INDEX IF EXISTS "idx_email_body_preview_trgm";

-- DropIndex
DROP INDEX IF EXISTS "idx_email_subject_trgm";

-- AlterTable
ALTER TABLE "AppSettings" DROP COLUMN IF EXISTS "agentSystemPrompt";

-- Add column only if it doesn't exist (safe for re-runs)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='AppSettings' AND column_name='agentCustomInstructions') THEN
    ALTER TABLE "AppSettings" ADD COLUMN "agentCustomInstructions" TEXT;
  END IF;
END $$;

-- AlterTable
ALTER TABLE "ChatSession" ALTER COLUMN "title" TYPE VARCHAR(50);
ALTER TABLE "ChatSession" ALTER COLUMN "processingSince" TYPE TIMESTAMP(3);
