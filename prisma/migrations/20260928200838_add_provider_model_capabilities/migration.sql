-- AlterTable
-- Idempotent so a failed/retried deploy can re-run it (see
-- `.pi/skills/database-migrations/SKILL.md`).
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'provider_api_key' AND column_name = 'modelCapabilities'
  ) THEN
    ALTER TABLE "provider_api_key" ADD COLUMN "modelCapabilities" JSONB;
  END IF;
END $$;
