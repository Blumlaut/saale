-- AlterTable
ALTER TABLE "ChatSession" ADD COLUMN     "lastSummarizedAt" TIMESTAMP(3),
ADD COLUMN     "memorySummary" TEXT;

-- CreateTable
CREATE TABLE "Memory" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "collection" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "importance" INTEGER NOT NULL DEFAULT 5,
    "source" TEXT,
    "accessCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Memory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Memory_userId_collection_idx" ON "Memory"("userId", "collection");

-- CreateIndex
CREATE INDEX "Memory_userId_tags_idx" ON "Memory"("userId", "tags");
