-- DropForeignKey
ALTER TABLE "provider_api_key" DROP CONSTRAINT "provider_api_key_userId_fkey";

-- AlterTable
ALTER TABLE "provider_api_key" ALTER COLUMN "userId" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "provider_api_key_provider_idx" ON "provider_api_key"("provider");

-- AddForeignKey
ALTER TABLE "provider_api_key" ADD CONSTRAINT "provider_api_key_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
