-- AlterTable
ALTER TABLE "McpServer" ADD COLUMN IF NOT EXISTS "transport" TEXT NOT NULL DEFAULT 'http';
ALTER TABLE "McpServer" ADD COLUMN IF NOT EXISTS "command" TEXT;
ALTER TABLE "McpServer" ADD COLUMN IF NOT EXISTS "cwd" TEXT;

-- A command server has no endpoint; existing rows are all http and keep theirs.
ALTER TABLE "McpServer" ALTER COLUMN "url" DROP NOT NULL;
