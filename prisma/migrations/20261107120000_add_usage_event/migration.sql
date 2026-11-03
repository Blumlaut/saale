-- The usage ledger: one row per model call, the table the admin usage page adds up.
CREATE TABLE IF NOT EXISTS "UsageEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" VARCHAR(20) NOT NULL,
    "provider" VARCHAR(100) NOT NULL,
    "model" VARCHAR(200) NOT NULL,
    "scope" VARCHAR(10) NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheRead" INTEGER NOT NULL DEFAULT 0,
    "cacheWrite" INTEGER NOT NULL DEFAULT 0,
    "cost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "billed" BOOLEAN NOT NULL DEFAULT false,
    "refId" VARCHAR(40),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UsageEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "UsageEvent_createdAt_idx" ON "UsageEvent"("createdAt");
CREATE INDEX IF NOT EXISTS "UsageEvent_userId_createdAt_idx" ON "UsageEvent"("userId", "createdAt");

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'UsageEvent_userId_fkey'
  ) THEN
    ALTER TABLE "UsageEvent" ADD CONSTRAINT "UsageEvent_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- Backfill the chat turns already recorded on `ChatMessage.stats`. Ids are
-- derived from the message so a retried migration writes nothing twice.
-- Attribution is the best the old rows allow: a provider the account holds its
-- own key for today is theirs, everything else was billed to the workspace.
INSERT INTO "UsageEvent" (
  "id", "userId", "kind", "provider", "model", "scope",
  "inputTokens", "outputTokens", "cacheRead", "cacheWrite",
  "cost", "billed", "refId", "createdAt"
)
SELECT
  'ue_' || md5(m."id"),
  s."userId",
  'chat',
  coalesce(m."stats"->'model'->>'provider', ''),
  coalesce(m."stats"->'model'->>'name', ''),
  CASE WHEN k."id" IS NULL THEN 'global' ELSE 'own' END,
  coalesce((m."stats"->'tokens'->>'input')::int, 0),
  coalesce((m."stats"->'tokens'->>'output')::int, 0),
  coalesce((m."stats"->'tokens'->>'cacheRead')::int, 0),
  coalesce((m."stats"->'tokens'->>'cacheWrite')::int, 0),
  coalesce((m."stats"->>'cost')::double precision, 0),
  coalesce((m."stats"->>'costFromProvider')::boolean, false),
  m."sessionId",
  m."createdAt"
FROM "ChatMessage" m
JOIN "ChatSession" s ON s."id" = m."sessionId"
LEFT JOIN provider_api_key k
  ON k."userId" = s."userId" AND k."provider" = (m."stats"->'model'->>'provider')
WHERE m."stats" IS NOT NULL
ON CONFLICT ("id") DO NOTHING;

-- Council turns carry their own cost. A member that inherits the council's
-- model has no provider on its row, so those rows are credited to the
-- workspace and the provider stays empty.
INSERT INTO "UsageEvent" (
  "id", "userId", "kind", "provider", "model", "scope",
  "inputTokens", "outputTokens", "cacheRead", "cacheWrite",
  "cost", "billed", "refId", "createdAt"
)
SELECT
  'ue_' || md5(t."id"),
  t."userId",
  'council',
  coalesce(mem."modelProvider", ''),
  coalesce(mem."modelName", ''),
  CASE WHEN k."id" IS NULL THEN 'global' ELSE 'own' END,
  t."inputTokens",
  t."outputTokens",
  0,
  0,
  t."cost",
  false,
  t."runId",
  t."createdAt"
FROM "CouncilMemberTurn" t
JOIN "user" u ON u."id" = t."userId"
LEFT JOIN "CouncilMember" mem ON mem."id" = t."memberId"
LEFT JOIN provider_api_key k
  ON k."userId" = t."userId" AND k."provider" = mem."modelProvider"
ON CONFLICT ("id") DO NOTHING;
