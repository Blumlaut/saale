-- A search without a named engine now draws from `web` as well as `general`:
-- `web` holds engines `general` does not, so one suspended scrape engine no
-- longer leaves the instance with a single source. Only the untouched default
-- moves; a list an admin picked keeps its value.

ALTER TABLE "admin_settings" ALTER COLUMN "webSearchCategories" SET DEFAULT ARRAY['general','web']::TEXT[];
UPDATE "admin_settings" SET "webSearchCategories" = ARRAY['general','web']::TEXT[] WHERE "webSearchCategories" = ARRAY['general']::TEXT[];
