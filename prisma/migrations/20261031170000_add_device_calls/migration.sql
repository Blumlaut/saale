-- CreateTable
CREATE TABLE "DeviceCall" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "tool" VARCHAR(64) NOT NULL,
    "summary" TEXT NOT NULL,
    "outcome" VARCHAR(16) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeviceCall_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DeviceCall_deviceId_createdAt_idx" ON "DeviceCall"("deviceId", "createdAt");

-- CreateIndex
CREATE INDEX "DeviceCall_userId_createdAt_idx" ON "DeviceCall"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "DeviceCall" ADD CONSTRAINT "DeviceCall_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceCall" ADD CONSTRAINT "DeviceCall_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
