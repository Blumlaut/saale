-- Make ChatSession.shared NOT NULL (idempotent, only if column exists)
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'ChatSession' AND column_name = 'shared' AND is_nullable = 'YES'
  ) THEN
    ALTER TABLE "ChatSession" ALTER COLUMN "shared" SET NOT NULL;
  END IF;
END $$;

-- Make EmailMessage.bodyPreview nullable (idempotent)
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'EmailMessage' AND column_name = 'bodyPreview' AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE "EmailMessage" ALTER COLUMN "bodyPreview" DROP NOT NULL;
  END IF;
END $$;
