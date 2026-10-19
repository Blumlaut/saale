-- AlterTable
ALTER TABLE "AppSettings" ADD COLUMN     "features" JSONB;

-- AlterTable
ALTER TABLE "admin_settings" ADD COLUMN     "featureDefaults" JSONB;
