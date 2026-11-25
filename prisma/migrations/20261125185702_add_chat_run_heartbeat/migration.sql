-- The run record gains a heartbeat: the process running a chat refreshes it,
-- so a row nobody is refreshing is the one a restart left behind.

ALTER TABLE "ChatRun" ADD COLUMN IF NOT EXISTS "heartbeatAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX IF NOT EXISTS "ChatRun_heartbeatAt_idx" ON "ChatRun"("heartbeatAt");
