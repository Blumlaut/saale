-- AlterTable
ALTER TABLE "AppSettings" ADD COLUMN IF NOT EXISTS "approvalDecisionModel" TEXT;

-- AlterTable
ALTER TABLE "admin_settings" ADD COLUMN IF NOT EXISTS "approvalDecisionModel" TEXT;
