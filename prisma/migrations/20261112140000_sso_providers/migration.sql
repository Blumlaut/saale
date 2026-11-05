-- A single provider row becomes a list: every row gets a slug that names its
-- callback, and the primary key stops being the literal "global".

ALTER TABLE "instance_sso" ADD COLUMN IF NOT EXISTS "slug" TEXT;
ALTER TABLE "instance_sso" ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- A provider stored before this migration keeps working as the "default" one.
UPDATE "instance_sso" SET "slug" = 'default' WHERE "slug" IS NULL;

ALTER TABLE "instance_sso" ALTER COLUMN "slug" SET NOT NULL;
ALTER TABLE "instance_sso" ALTER COLUMN "id" DROP DEFAULT;

CREATE UNIQUE INDEX IF NOT EXISTS "instance_sso_slug_key" ON "instance_sso"("slug");
