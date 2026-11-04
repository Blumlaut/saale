-- The council feature is gone, and its rows only made sense to its code.
-- Children first, so no foreign key is left pointing at a dropped table.
DROP TABLE IF EXISTS "CouncilMemberTurn";
DROP TABLE IF EXISTS "CouncilMessage";
DROP TABLE IF EXISTS "CouncilRun";
DROP TABLE IF EXISTS "CouncilMember";
DROP TABLE IF EXISTS "Council";

-- A stored feature switch named a module that no longer exists.
UPDATE "AppSettings"
   SET "features" = "features" - 'council'
 WHERE "features" ? 'council';
UPDATE "admin_settings"
   SET "featureDefaults" = "featureDefaults" - 'council'
 WHERE "featureDefaults" ? 'council';

-- And the same name in a saved sidebar layout: drop the entry, keep the order.
UPDATE "AppSettings"
   SET "sidebarItems" = (
     SELECT coalesce(jsonb_agg(entry ORDER BY position), '[]'::jsonb)
       FROM jsonb_array_elements("sidebarItems") WITH ORDINALITY AS rows(entry, position)
      WHERE entry ->> 'id' <> 'council'
   )
 WHERE jsonb_typeof("sidebarItems") = 'array'
   AND "sidebarItems" @> '[{"id": "council"}]'::jsonb;

-- Its model calls leave the cost ledger with it.
DELETE FROM "UsageEvent" WHERE "kind" = 'council';
