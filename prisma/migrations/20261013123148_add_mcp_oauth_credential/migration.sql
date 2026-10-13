-- CreateTable
CREATE TABLE "McpOAuthCredential" (
    "serverId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "serverUrl" TEXT NOT NULL,
    "encryptedState" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "McpOAuthCredential_pkey" PRIMARY KEY ("serverId")
);

-- CreateIndex
CREATE INDEX "McpOAuthCredential_userId_idx" ON "McpOAuthCredential"("userId");

-- AddForeignKey
ALTER TABLE "McpOAuthCredential" ADD CONSTRAINT "McpOAuthCredential_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "McpOAuthCredential" ADD CONSTRAINT "McpOAuthCredential_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "McpServer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
