-- AlterTable
ALTER TABLE "CoderProject" ADD COLUMN     "chatMode" TEXT NOT NULL DEFAULT 'worktree',
ADD COLUMN     "repoSetupAt" TIMESTAMP(3);
