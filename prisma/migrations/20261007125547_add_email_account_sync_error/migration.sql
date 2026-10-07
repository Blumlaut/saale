-- AlterTable
-- Failure-safe: a retry after a partial run must not fail on an existing column.
ALTER TABLE "EmailAccount" ADD COLUMN IF NOT EXISTS "lastSyncError" TEXT,
ADD COLUMN IF NOT EXISTS "lastSyncErrorAt" TIMESTAMP(3);
