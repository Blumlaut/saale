-- The models-manager, user-manager and support bundles no longer ship; only the
-- two anchor roles remain. A row an account still holds is kept, but as an
-- ordinary role the admin can edit or delete.
UPDATE "Role" r
SET "builtin" = false
WHERE r."builtin" = true
  AND r."name" IN ('models-manager', 'user-manager', 'support')
  AND EXISTS (
    SELECT 1
    FROM "user" u, unnest(string_to_array(u."role", ',')) AS held
    WHERE btrim(held) = r."name"
  );

DELETE FROM "Role" r
WHERE r."builtin" = true
  AND r."name" IN ('models-manager', 'user-manager', 'support')
  AND NOT EXISTS (
    SELECT 1
    FROM "user" u, unnest(string_to_array(u."role", ',')) AS held
    WHERE btrim(held) = r."name"
  );
