/*
  Warnings:

  - You are about to drop the column `agentSystemPrompt` on the `AppSettings` table. All the data in the column will be lost.
  - You are about to alter the column `title` on the `ChatSession` table. The data in that column could be lost. The data in that column will be cast from `Text` to `VarChar(50)`.

*/
-- DropIndex
DROP INDEX "idx_chat_session_title_trgm";

-- DropIndex
DROP INDEX "idx_email_body_preview_trgm";

-- DropIndex
DROP INDEX "idx_email_subject_trgm";

-- AlterTable
ALTER TABLE "AppSettings" DROP COLUMN "agentSystemPrompt",
ADD COLUMN     "agentCustomInstructions" TEXT;

-- AlterTable
ALTER TABLE "ChatSession" ALTER COLUMN "title" SET DATA TYPE VARCHAR(50),
ALTER COLUMN "processingSince" SET DATA TYPE TIMESTAMP(3);
