-- A watcher's script no longer needs the user's approval before it runs, so the
-- grant it was checked against goes with it.
ALTER TABLE "ScriptWatcher" DROP COLUMN IF EXISTS "scriptHash";
ALTER TABLE "ScriptWatcher" DROP COLUMN IF EXISTS "grantedTools";
ALTER TABLE "ScriptWatcher" DROP COLUMN IF EXISTS "grantAll";
