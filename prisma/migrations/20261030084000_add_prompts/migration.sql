-- CreateTable
CREATE TABLE IF NOT EXISTS "Prompt" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" VARCHAR(40) NOT NULL,
    "description" VARCHAR(100) NOT NULL,
    "argumentHint" VARCHAR(100),
    "scope" TEXT NOT NULL DEFAULT 'any',
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Prompt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Prompt_userId_idx" ON "Prompt"("userId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Prompt_userId_name_key" ON "Prompt"("userId", "name");

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Prompt_userId_fkey') THEN
    ALTER TABLE "Prompt" ADD CONSTRAINT "Prompt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
