-- Web tool defaults (which sources a search may use, and the fetch budget) and
-- the voice input overrides. Null voice fields follow the environment.

ALTER TABLE "admin_settings" ADD COLUMN IF NOT EXISTS "webSearchEngines" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "admin_settings" ADD COLUMN IF NOT EXISTS "webSearchCategories" TEXT[] NOT NULL DEFAULT ARRAY['general']::TEXT[];
ALTER TABLE "admin_settings" ADD COLUMN IF NOT EXISTS "webSearchSafeSearch" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "admin_settings" ADD COLUMN IF NOT EXISTS "webSearchLanguage" TEXT NOT NULL DEFAULT 'all';
ALTER TABLE "admin_settings" ADD COLUMN IF NOT EXISTS "webSearchResultsPerCall" INTEGER NOT NULL DEFAULT 10;
ALTER TABLE "admin_settings" ADD COLUMN IF NOT EXISTS "webFetchMaxChars" INTEGER NOT NULL DEFAULT 50000;
ALTER TABLE "admin_settings" ADD COLUMN IF NOT EXISTS "webFetchTimeoutMs" INTEGER NOT NULL DEFAULT 15000;
ALTER TABLE "admin_settings" ADD COLUMN IF NOT EXISTS "webFetchMaxRedirects" INTEGER NOT NULL DEFAULT 5;
ALTER TABLE "admin_settings" ADD COLUMN IF NOT EXISTS "voiceEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "admin_settings" ADD COLUMN IF NOT EXISTS "voiceModel" TEXT;
ALTER TABLE "admin_settings" ADD COLUMN IF NOT EXISTS "voiceLanguage" TEXT;
