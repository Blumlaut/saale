-- The image model each scope renders with. Null leaves `generate_image` out of
-- the session entirely, so nothing is generated before someone picks a model.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'AppSettings' AND column_name = 'imageModel') THEN
    ALTER TABLE "AppSettings" ADD COLUMN "imageModel" TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'admin_settings' AND column_name = 'imageModel') THEN
    ALTER TABLE "admin_settings" ADD COLUMN "imageModel" TEXT;
  END IF;
END $$;
