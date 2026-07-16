-- Add editedAt column to ChatMessage (missing from init)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='ChatMessage' AND column_name='editedAt') THEN
    ALTER TABLE "ChatMessage" ADD COLUMN "editedAt" TIMESTAMP(3);
  END IF;
END $$;
