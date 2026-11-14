-- Resolutions belong to the image model, recorded per model in
-- `provider_api_key.modelCapabilities`, not to the account.
ALTER TABLE "AppSettings" DROP COLUMN IF EXISTS "imageSizes";
