-- The built-in `admin` role was seeded before the plugins slice existed, and the
-- seed skips existing rows. Grant it, so an install that already has its role
-- table can open /admin/plugins without an admin editing the role by hand.
UPDATE "Role"
SET "permissions" = jsonb_set(
    "permissions",
    '{admin}',
    (
        SELECT jsonb_agg(DISTINCT action)
        FROM (
            SELECT jsonb_array_elements_text(COALESCE("permissions" -> 'admin', '[]'::jsonb)) AS action
            UNION
            SELECT 'plugins'
        ) AS actions
    )
)
WHERE "name" = 'admin'
  AND "builtin" = true
  AND NOT (COALESCE("permissions" -> 'admin', '[]'::jsonb) @> '["plugins"]'::jsonb);
