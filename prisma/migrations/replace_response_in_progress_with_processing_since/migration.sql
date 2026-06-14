-- AlterTable: replace responseInProgress boolean with processingSince timestamp
ALTER TABLE "ChatSession" DROP COLUMN IF EXISTS "responseInProgress";

-- Add processingSince only if it doesn't already exist
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='ChatSession' AND column_name='processingSince') THEN
    ALTER TABLE "ChatSession" ADD COLUMN "processingSince" TIMESTAMPTZ(3);
  END IF;
END $$;
