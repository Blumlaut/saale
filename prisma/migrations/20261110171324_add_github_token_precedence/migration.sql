-- AlterTable
ALTER TABLE "admin_settings" ADD COLUMN IF NOT EXISTS "githubTokenPrecedence" TEXT NOT NULL DEFAULT 'app';
