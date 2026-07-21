-- CreateTable (idempotent)
CREATE TABLE IF NOT EXISTS "GitHubAccount" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "encryptedToken" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "username" TEXT,
    "avatarUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GitHubAccount_pkey" PRIMARY KEY ("id")
);

-- CreateIndex (idempotent)
CREATE INDEX IF NOT EXISTS "GitHubAccount_userId_idx" ON "GitHubAccount"("userId");

-- CreateIndex (idempotent)
CREATE UNIQUE INDEX IF NOT EXISTS "GitHubAccount_userId_key" ON "GitHubAccount"("userId");

-- AddForeignKey (idempotent — only if constraint doesn't exist)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'GitHubAccount_userId_fkey'
  ) THEN
    ALTER TABLE "GitHubAccount" ADD CONSTRAINT "GitHubAccount_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
