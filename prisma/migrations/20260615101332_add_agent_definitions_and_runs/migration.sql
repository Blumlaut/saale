-- AlterTable (idempotent — only runs if column exists and is nullable)
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'ChatSession' AND column_name = 'shared' AND is_nullable = 'YES'
  ) THEN
    ALTER TABLE "ChatSession" ALTER COLUMN "shared" SET NOT NULL;
  END IF;
END $$;

-- CreateTable (idempotent)
CREATE TABLE IF NOT EXISTS "AgentDefinition" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "description" TEXT,
    "prompt" TEXT NOT NULL,
    "systemPrompt" TEXT,
    "toolConfig" JSONB,
    "modelId" TEXT,
    "thinkingLevel" TEXT NOT NULL DEFAULT 'off',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable (idempotent)
CREATE TABLE IF NOT EXISTS "AgentRun" (
    "id" TEXT NOT NULL,
    "definitionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "prompt" TEXT NOT NULL,
    "systemPrompt" TEXT,
    "modelId" TEXT,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "cost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "error" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable (idempotent)
CREATE TABLE IF NOT EXISTS "AgentRunMessage" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "thinking" TEXT,
    "toolCalls" TEXT,
    "parentMessageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentRunMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex (idempotent)
CREATE INDEX IF NOT EXISTS "AgentDefinition_userId_enabled_idx" ON "AgentDefinition"("userId", "enabled");

-- CreateIndex (idempotent)
CREATE UNIQUE INDEX IF NOT EXISTS "AgentDefinition_userId_name_key" ON "AgentDefinition"("userId", "name");

-- CreateIndex (idempotent)
CREATE INDEX IF NOT EXISTS "AgentRun_definitionId_createdAt_idx" ON "AgentRun"("definitionId", "createdAt");

-- CreateIndex (idempotent)
CREATE INDEX IF NOT EXISTS "AgentRun_userId_status_idx" ON "AgentRun"("userId", "status");

-- CreateIndex (idempotent)
CREATE INDEX IF NOT EXISTS "AgentRun_userId_createdAt_idx" ON "AgentRun"("userId", "createdAt");

-- CreateIndex (idempotent)
CREATE INDEX IF NOT EXISTS "AgentRunMessage_runId_createdAt_idx" ON "AgentRunMessage"("runId", "createdAt");

-- AddForeignKey (idempotent — only adds if constraint doesn't exist)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'AgentDefinition_userId_fkey') THEN
    ALTER TABLE "AgentDefinition" ADD CONSTRAINT "AgentDefinition_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'AgentRun_definitionId_fkey') THEN
    ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_definitionId_fkey" FOREIGN KEY ("definitionId") REFERENCES "AgentDefinition"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'AgentRunMessage_runId_fkey') THEN
    ALTER TABLE "AgentRunMessage" ADD CONSTRAINT "AgentRunMessage_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
