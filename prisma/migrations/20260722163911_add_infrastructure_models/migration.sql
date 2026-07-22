-- CreateTable
CREATE TABLE "InfraMachine" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL DEFAULT 22,
    "username" TEXT NOT NULL,
    "authMethod" TEXT NOT NULL DEFAULT 'key',
    "encryptedKey" TEXT,
    "encryptedPass" TEXT,
    "passPhrase" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InfraMachine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InfraNote" (
    "id" TEXT NOT NULL,
    "machineId" TEXT NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "content" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'general',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InfraNote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InfraMachine_userId_idx" ON "InfraMachine"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "InfraMachine_userId_name_key" ON "InfraMachine"("userId", "name");

-- CreateIndex
CREATE INDEX "InfraNote_machineId_category_idx" ON "InfraNote"("machineId", "category");

-- AddForeignKey
ALTER TABLE "InfraMachine" ADD CONSTRAINT "InfraMachine_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InfraNote" ADD CONSTRAINT "InfraNote_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "InfraMachine"("id") ON DELETE CASCADE ON UPDATE CASCADE;
