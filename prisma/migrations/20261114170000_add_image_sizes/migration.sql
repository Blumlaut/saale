-- Sizes an account's image renders may use, as "WxH". The first entry is the
-- default; an empty array follows `DEFAULT_IMAGE_SIZES`.
ALTER TABLE "AppSettings" ADD COLUMN IF NOT EXISTS "imageSizes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
