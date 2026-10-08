-- CreateTable
CREATE TABLE "ScriptWatcher" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "description" TEXT,
    "script" TEXT NOT NULL,
    "scriptHash" TEXT NOT NULL,
    "grantedTools" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "grantAll" BOOLEAN NOT NULL DEFAULT false,
    "cronExpression" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "sessionId" TEXT,
    "wakePrompt" TEXT NOT NULL,
    "modelId" TEXT,
    "store" JSONB NOT NULL DEFAULT '{}',
    "lastValue" TEXT,
    "lastTickAt" TIMESTAMP(3),
    "lastError" TEXT,
    "lastFiredAt" TIMESTAMP(3),
    "tickCount" INTEGER NOT NULL DEFAULT 0,
    "fireCount" INTEGER NOT NULL DEFAULT 0,
    "cooldownMinutes" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScriptWatcher_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScriptWatcherTick" (
    "id" TEXT NOT NULL,
    "watcherId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "value" TEXT,
    "error" TEXT,
    "output" TEXT,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "callCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScriptWatcherTick_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ScriptWatcher_userId_enabled_idx" ON "ScriptWatcher"("userId", "enabled");

-- CreateIndex
CREATE INDEX "ScriptWatcher_sessionId_idx" ON "ScriptWatcher"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "ScriptWatcher_userId_name_key" ON "ScriptWatcher"("userId", "name");

-- CreateIndex
CREATE INDEX "ScriptWatcherTick_watcherId_createdAt_idx" ON "ScriptWatcherTick"("watcherId", "createdAt");

-- AddForeignKey
ALTER TABLE "ScriptWatcher" ADD CONSTRAINT "ScriptWatcher_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ChatSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScriptWatcher" ADD CONSTRAINT "ScriptWatcher_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScriptWatcherTick" ADD CONSTRAINT "ScriptWatcherTick_watcherId_fkey" FOREIGN KEY ("watcherId") REFERENCES "ScriptWatcher"("id") ON DELETE CASCADE ON UPDATE CASCADE;
