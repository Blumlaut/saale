-- Account policy: shortest password the instance accepts, and whether two-factor
-- sign-in is required. Both default to the behaviour every instance had before.

ALTER TABLE "admin_settings" ADD COLUMN IF NOT EXISTS "minPasswordLength" INTEGER NOT NULL DEFAULT 8;
ALTER TABLE "admin_settings" ADD COLUMN IF NOT EXISTS "requireTwoFactor" BOOLEAN NOT NULL DEFAULT false;
