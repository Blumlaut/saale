-- AlterTable
ALTER TABLE "admin_settings" ADD COLUMN IF NOT EXISTS "commitAttributionEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "admin_settings" ADD COLUMN IF NOT EXISTS "commitAttributionText" TEXT NOT NULL DEFAULT '';
