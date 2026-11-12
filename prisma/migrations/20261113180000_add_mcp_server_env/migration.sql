-- AlterTable
ALTER TABLE "McpServer" ADD COLUMN IF NOT EXISTS "env" TEXT;

-- A shared server belongs to every account, so it carries no variables of its own.
