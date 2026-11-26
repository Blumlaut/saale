-- Indexes for the two sources the palette gained: automations and machines.
-- Every expression here has to stay identical to the one in
-- `src/lib/search/sources.ts`, or postgres recomputes it per row.

-- ─── Automations ─────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS "ScriptWatcher_name_trgm_idx"
  ON "ScriptWatcher" USING gin (name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "ScriptWatcher_description_trgm_idx"
  ON "ScriptWatcher" USING gin (description gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "ScriptWatcher_search_fts_idx"
  ON "ScriptWatcher" USING gin ((
    setweight(to_tsvector('english', coalesce(name, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(description, '')), 'B')
  ));

-- ─── Machines ────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS "InfraMachine_name_trgm_idx"
  ON "InfraMachine" USING gin (name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "InfraMachine_host_trgm_idx"
  ON "InfraMachine" USING gin (host gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "InfraMachine_username_trgm_idx"
  ON "InfraMachine" USING gin (username gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "InfraMachine_search_fts_idx"
  ON "InfraMachine" USING gin ((
    setweight(to_tsvector('english', coalesce(name, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(host, '') || ' ' || coalesce(username, '')), 'B')
  ));
