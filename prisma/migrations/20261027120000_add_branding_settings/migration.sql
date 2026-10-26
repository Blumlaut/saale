-- Branding: sparse accent colours per mode, and the uploaded agent avatar.
ALTER TABLE "admin_settings" ADD COLUMN IF NOT EXISTS "themeColors" JSONB;
ALTER TABLE "admin_settings" ADD COLUMN IF NOT EXISTS "brandingAvatar" TEXT NOT NULL DEFAULT '';
