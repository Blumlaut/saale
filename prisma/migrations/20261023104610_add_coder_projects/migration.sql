-- AlterTable
ALTER TABLE "AppSettings" ADD COLUMN IF NOT EXISTS "coderToolConfig" JSONB;

-- AlterTable
ALTER TABLE "ChatSession" ADD COLUMN IF NOT EXISTS "projectId" TEXT;

-- CreateTable
CREATE TABLE IF NOT EXISTS "CoderProject" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "slug" VARCHAR(100) NOT NULL,
    "repoPath" TEXT NOT NULL,
    "originUrl" TEXT,
    "defaultBranch" TEXT NOT NULL DEFAULT 'main',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CoderProject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "CoderWorktree" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "branch" TEXT NOT NULL,
    "baseSha" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "removedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CoderWorktree_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CoderProject_userId_idx" ON "CoderProject"("userId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "CoderProject_userId_slug_key" ON "CoderProject"("userId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "CoderWorktree_sessionId_key" ON "CoderWorktree"("sessionId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CoderWorktree_projectId_idx" ON "CoderWorktree"("projectId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ChatSession_projectId_lastActivityAt_idx" ON "ChatSession"("projectId", "lastActivityAt");

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ChatSession_projectId_fkey'
  ) THEN
    ALTER TABLE "ChatSession"
      ADD CONSTRAINT "ChatSession_projectId_fkey"
      FOREIGN KEY ("projectId") REFERENCES "CoderProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'CoderProject_userId_fkey'
  ) THEN
    ALTER TABLE "CoderProject"
      ADD CONSTRAINT "CoderProject_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'CoderWorktree_projectId_fkey'
  ) THEN
    ALTER TABLE "CoderWorktree"
      ADD CONSTRAINT "CoderWorktree_projectId_fkey"
      FOREIGN KEY ("projectId") REFERENCES "CoderProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'CoderWorktree_sessionId_fkey'
  ) THEN
    ALTER TABLE "CoderWorktree"
      ADD CONSTRAINT "CoderWorktree_sessionId_fkey"
      FOREIGN KEY ("sessionId") REFERENCES "ChatSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
