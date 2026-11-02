-- Automations absorb agent jobs.
--
-- A watcher becomes an automation: an optional script gate, a schedule that may
-- be absent, a fire limit and a thinking level for the runs that have no chat.
-- Every agent job definition is copied across as an automation with no gate, so
-- it fires on every tick, and the job tables are dropped afterwards.

-- ─── The automation columns ────────────────────────────────────────────────

ALTER TABLE "ScriptWatcher" ALTER COLUMN "script" DROP NOT NULL;
ALTER TABLE "ScriptWatcher" ALTER COLUMN "cronExpression" DROP NOT NULL;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ScriptWatcher' AND column_name = 'thinkingLevel') THEN
    ALTER TABLE "ScriptWatcher" ADD COLUMN "thinkingLevel" TEXT NOT NULL DEFAULT 'off';
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ScriptWatcher' AND column_name = 'maxFires') THEN
    ALTER TABLE "ScriptWatcher" ADD COLUMN "maxFires" INTEGER;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ScriptWatcherTick' AND column_name = 'answer') THEN
    ALTER TABLE "ScriptWatcherTick" ADD COLUMN "answer" TEXT;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ScriptWatcherTick' AND column_name = 'inputTokens') THEN
    ALTER TABLE "ScriptWatcherTick" ADD COLUMN "inputTokens" INTEGER NOT NULL DEFAULT 0;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ScriptWatcherTick' AND column_name = 'outputTokens') THEN
    ALTER TABLE "ScriptWatcherTick" ADD COLUMN "outputTokens" INTEGER NOT NULL DEFAULT 0;
  END IF;
END $$;

-- ─── Agent jobs become automations ─────────────────────────────────────────

DO $$
DECLARE
  job RECORD;
  automation_name TEXT;
  attempt INTEGER;
  schedule TEXT;
  fires INTEGER;
  runs BOOLEAN;
  last_run TIMESTAMP(3);
BEGIN
  IF to_regclass('"AgentDefinition"') IS NULL THEN
    RETURN;
  END IF;

  FOR job IN SELECT * FROM "AgentDefinition" ORDER BY "createdAt" LOOP
    -- Names are unique per user, and a watcher may already hold this one.
    automation_name := LEFT(job.name, 100);
    attempt := 0;
    WHILE EXISTS (
      SELECT 1 FROM "ScriptWatcher" w WHERE w."userId" = job."userId" AND w.name = automation_name
    ) AND attempt < 100 LOOP
      attempt := attempt + 1;
      automation_name := LEFT(job.name, 100 - LENGTH(attempt::TEXT) - 2) || ' ' || attempt::TEXT;
    END LOOP;

    IF job."runAt" IS NOT NULL THEN
      -- A one-off becomes a cron naming that minute, fired once. Past times are
      -- dropped rather than re-run: the job already had its chance.
      schedule := CONCAT(
        EXTRACT(MINUTE FROM job."runAt" AT TIME ZONE 'UTC')::INT, ' ',
        EXTRACT(HOUR FROM job."runAt" AT TIME ZONE 'UTC')::INT, ' ',
        EXTRACT(DAY FROM job."runAt" AT TIME ZONE 'UTC')::INT, ' ',
        EXTRACT(MONTH FROM job."runAt" AT TIME ZONE 'UTC')::INT, ' *'
      );
      fires := 1;
      runs := job.enabled AND job."runAt" > NOW();
    ELSE
      schedule := job."cronExpression";
      fires := NULL;
      runs := job.enabled;
    END IF;

    INSERT INTO "ScriptWatcher" (
      id, "userId", name, description, script, "cronExpression", enabled, deliver,
      "sessionId", "originSessionId", "projectId", "worktreeMode", "retentionMinutes",
      "stickySessionId", "wakePrompt", "modelId", "thinkingLevel", store,
      "lastValue", "lastTickAt", "lastError", "lastFiredAt", "tickCount", "fireCount",
      "cooldownMinutes", "maxFires", "createdAt", "updatedAt"
    ) VALUES (
      job.id, job."userId", automation_name, job.description, NULL, schedule, runs, 'none',
      NULL, NULL, NULL, 'per-fire', 1440,
      NULL, job.prompt, job."modelId", job."thinkingLevel", '{}'::jsonb,
      NULL, job."lastRunAt", NULL, NULL, 0, 0,
      0, fires, job."createdAt", job."updatedAt"
    )
    ON CONFLICT DO NOTHING;
  END LOOP;
END $$;

-- ─── The job tables go ─────────────────────────────────────────────────────

DROP TABLE IF EXISTS "AgentRunMessage";
DROP TABLE IF EXISTS "AgentRun";
DROP TABLE IF EXISTS "AgentDefinition";
