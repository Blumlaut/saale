-- AlterTable
ALTER TABLE "admin_settings" ADD COLUMN     "piPluginStates" JSONB,
ADD COLUMN     "piPluginsDir" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "piPluginsEnabled" BOOLEAN NOT NULL DEFAULT false;
