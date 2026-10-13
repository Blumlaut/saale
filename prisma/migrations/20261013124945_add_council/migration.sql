-- CreateTable
CREATE TABLE "Council" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "brief" TEXT NOT NULL,
    "toolConfig" JSONB,
    "orchestration" TEXT NOT NULL DEFAULT 'parallel',
    "stopVoteThreshold" TEXT NOT NULL DEFAULT 'majority',
    "maxDurationSeconds" INTEGER,
    "maxTokens" INTEGER,
    "maxCostUsd" DOUBLE PRECISION,
    "sandboxKey" TEXT NOT NULL,
    "sandboxReady" BOOLEAN NOT NULL DEFAULT false,
    "nextSeq" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'idle',
    "lastRunAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Council_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CouncilMember" (
    "id" TEXT NOT NULL,
    "councilId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" VARCHAR(50) NOT NULL,
    "instructions" TEXT,
    "modelProvider" TEXT,
    "modelName" TEXT,
    "thinkingLevel" TEXT NOT NULL DEFAULT 'default',
    "toolConfig" JSONB,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CouncilMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CouncilRun" (
    "id" TEXT NOT NULL,
    "councilId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "stopReason" TEXT,
    "triggerMessageId" TEXT,
    "maxDurationSeconds" INTEGER,
    "maxTokens" INTEGER,
    "maxCostUsd" DOUBLE PRECISION,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "cost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "turnCount" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "lastHeartbeatAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CouncilRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CouncilMessage" (
    "id" TEXT NOT NULL,
    "councilId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "runId" TEXT,
    "seq" INTEGER NOT NULL,
    "authorKind" TEXT NOT NULL,
    "memberId" TEXT,
    "authorName" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "mentions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CouncilMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CouncilMemberTurn" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "councilId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "memberId" TEXT,
    "memberName" VARCHAR(50) NOT NULL,
    "triggeredBy" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "seenThrough" INTEGER,
    "postedSeqs" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "thinking" TEXT,
    "toolCalls" TEXT,
    "finalText" TEXT,
    "status" TEXT NOT NULL DEFAULT 'running',
    "error" TEXT,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "cost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CouncilMemberTurn_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Council_sandboxKey_key" ON "Council"("sandboxKey");

-- CreateIndex
CREATE INDEX "Council_userId_createdAt_idx" ON "Council"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "CouncilMember_userId_idx" ON "CouncilMember"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "CouncilMember_councilId_name_key" ON "CouncilMember"("councilId", "name");

-- CreateIndex
CREATE INDEX "CouncilRun_councilId_createdAt_idx" ON "CouncilRun"("councilId", "createdAt");

-- CreateIndex
CREATE INDEX "CouncilRun_userId_status_idx" ON "CouncilRun"("userId", "status");

-- CreateIndex
CREATE INDEX "CouncilMessage_councilId_createdAt_idx" ON "CouncilMessage"("councilId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CouncilMessage_councilId_seq_key" ON "CouncilMessage"("councilId", "seq");

-- CreateIndex
CREATE INDEX "CouncilMemberTurn_runId_createdAt_idx" ON "CouncilMemberTurn"("runId", "createdAt");

-- CreateIndex
CREATE INDEX "CouncilMemberTurn_memberId_createdAt_idx" ON "CouncilMemberTurn"("memberId", "createdAt");

-- AddForeignKey
ALTER TABLE "Council" ADD CONSTRAINT "Council_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CouncilMember" ADD CONSTRAINT "CouncilMember_councilId_fkey" FOREIGN KEY ("councilId") REFERENCES "Council"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CouncilRun" ADD CONSTRAINT "CouncilRun_councilId_fkey" FOREIGN KEY ("councilId") REFERENCES "Council"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CouncilMessage" ADD CONSTRAINT "CouncilMessage_councilId_fkey" FOREIGN KEY ("councilId") REFERENCES "Council"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CouncilMemberTurn" ADD CONSTRAINT "CouncilMemberTurn_runId_fkey" FOREIGN KEY ("runId") REFERENCES "CouncilRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CouncilMemberTurn" ADD CONSTRAINT "CouncilMemberTurn_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "CouncilMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;
