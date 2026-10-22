-- Environment variables handed to an identity's commands.
CREATE TABLE IF NOT EXISTS "SandboxEnvVar" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "encryptedValue" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SandboxEnvVar_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "SandboxEnvVar_userId_idx" ON "SandboxEnvVar"("userId");

CREATE UNIQUE INDEX IF NOT EXISTS "SandboxEnvVar_userId_name_key" ON "SandboxEnvVar"("userId", "name");

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'SandboxEnvVar_userId_fkey'
  ) THEN
    ALTER TABLE "SandboxEnvVar"
      ADD CONSTRAINT "SandboxEnvVar_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- GitHub was the one integration whose whole job was a variable: its token.
-- The ciphertext carries over unchanged, because it is the same AES-256-GCM
-- cipher under the same ENCRYPTION_KEY. A disabled integration never had its
-- token injected, so those rows are left out.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'GitHubAccount'
  ) THEN
    INSERT INTO "SandboxEnvVar" ("id", "userId", "name", "encryptedValue", "createdAt", "updatedAt")
    SELECT 'gh_' || substr(md5(random()::text || "userId"), 1, 21),
           "userId",
           'GH_TOKEN',
           "encryptedToken",
           now(),
           now()
    FROM "GitHubAccount"
    WHERE "enabled" = true
    ON CONFLICT ("userId", "name") DO NOTHING;

    DROP TABLE "GitHubAccount";
  END IF;
END $$;
