-- AlterTable
ALTER TABLE "ChatSession" ADD COLUMN IF NOT EXISTS "clientDeviceId" TEXT;

-- CreateTable
CREATE TABLE "Device" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "platform" VARCHAR(16) NOT NULL DEFAULT 'linux',
    "session" VARCHAR(16) NOT NULL DEFAULT 'unknown',
    "tokenHash" TEXT NOT NULL,
    "capabilities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "agentVersion" TEXT NOT NULL DEFAULT '',
    "lastSeenAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Device_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DevicePairCode" (
    "id" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DevicePairCode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Device_tokenHash_key" ON "Device"("tokenHash");

-- CreateIndex
CREATE INDEX "Device_userId_idx" ON "Device"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Device_userId_name_key" ON "Device"("userId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "DevicePairCode_codeHash_key" ON "DevicePairCode"("codeHash");

-- CreateIndex
CREATE INDEX "DevicePairCode_userId_idx" ON "DevicePairCode"("userId");

-- CreateIndex
CREATE INDEX "DevicePairCode_expiresAt_idx" ON "DevicePairCode"("expiresAt");

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DevicePairCode" ADD CONSTRAINT "DevicePairCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
