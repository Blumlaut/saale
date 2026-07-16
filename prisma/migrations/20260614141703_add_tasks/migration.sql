-- DropIndex (idempotent)
DROP INDEX IF EXISTS "idx_chat_session_title_trgm";
DROP INDEX IF EXISTS "idx_email_body_preview_trgm";
DROP INDEX IF EXISTS "idx_email_subject_trgm";

-- AlterTable (idempotent)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='EmailMessage' AND column_name='taskScanned') THEN
    ALTER TABLE "EmailMessage" ADD COLUMN "taskScanned" BOOLEAN NOT NULL DEFAULT false;
  END IF;
END $$;

-- CreateTable (idempotent)
CREATE TABLE IF NOT EXISTS "Task" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "priority" TEXT NOT NULL DEFAULT 'medium',
    "dueDate" TIMESTAMP(3),
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "order" INTEGER NOT NULL DEFAULT 0,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "sourceEmailId" TEXT,
    "completedAt" TIMESTAMP(3),
    "notifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateIndex (idempotent)
CREATE INDEX IF NOT EXISTS "Task_userId_status_dueDate_idx" ON "Task"("userId", "status", "dueDate");
CREATE INDEX IF NOT EXISTS "Task_userId_status_priority_idx" ON "Task"("userId", "status", "priority");

-- AddForeignKey (idempotent)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'Task_userId_fkey') THEN
    ALTER TABLE "Task" ADD CONSTRAINT "Task_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
