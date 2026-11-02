-- The name the instance shows. An empty value draws the built-in name.

ALTER TABLE "admin_settings" ADD COLUMN IF NOT EXISTS "workspaceName" TEXT NOT NULL DEFAULT '';
