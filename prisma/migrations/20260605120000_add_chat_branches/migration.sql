-- 1. Create ChatBranch table
CREATE TABLE "ChatBranch" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "divergenceMessageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChatBranch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex on ChatBranch
CREATE INDEX "ChatBranch_sessionId_idx" ON "ChatBranch"("sessionId");

-- 2. Add branchId column to ChatMessage (nullable first for backfill)
ALTER TABLE "ChatMessage" ADD COLUMN "branchId" TEXT;

-- CreateIndex on ChatMessage.branchId (column exists now)
CREATE INDEX "ChatMessage_branchId_idx" ON "ChatMessage"("branchId");

-- 3. Backfill: set branchId = sessionId for all existing messages
UPDATE "ChatMessage" SET "branchId" = "sessionId";

-- 4. Make branchId non-nullable
ALTER TABLE "ChatMessage" ALTER COLUMN "branchId" SET NOT NULL;

-- 5. Create main branch records for all existing sessions (id == sessionId)
INSERT INTO "ChatBranch" ("id", "sessionId", "divergenceMessageId", "createdAt", "updatedAt")
SELECT "id", "id", NULL, "createdAt", "createdAt"
FROM "ChatSession"
ON CONFLICT ("id") DO NOTHING;

-- 6. Add foreign key constraints (after data is in place)
ALTER TABLE "ChatBranch" ADD CONSTRAINT "ChatBranch_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ChatSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "ChatBranch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 7. Drop fork fields (no longer needed — replaced by branching)
ALTER TABLE "ChatSession" DROP COLUMN IF EXISTS "forkedFromSessionId";
ALTER TABLE "ChatSession" DROP COLUMN IF EXISTS "forkedAtMessageId";
