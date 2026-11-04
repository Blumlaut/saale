-- AlterTable
ALTER TABLE "AppSettings" ADD COLUMN     "githubSource" TEXT NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "admin_settings" ADD COLUMN     "githubMethod" TEXT NOT NULL DEFAULT 'choice';

-- CreateTable
CREATE TABLE "GithubApp" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "appId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "encryptedClientSecret" TEXT NOT NULL,
    "encryptedPrivateKey" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ownerLogin" TEXT NOT NULL,
    "permissions" JSONB,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "updatedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GithubApp_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GithubInstallation" (
    "id" TEXT NOT NULL,
    "installationId" TEXT NOT NULL,
    "accountLogin" TEXT NOT NULL,
    "accountType" TEXT NOT NULL DEFAULT '',
    "repositorySelection" TEXT NOT NULL DEFAULT '',
    "repositories" JSONB,
    "permissions" JSONB,
    "suspendedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GithubInstallation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GithubInstallationAccess" (
    "userId" TEXT NOT NULL,
    "installationId" TEXT NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GithubInstallationAccess_pkey" PRIMARY KEY ("userId","installationId")
);

-- CreateTable
CREATE TABLE "GithubUserToken" (
    "userId" TEXT NOT NULL,
    "encryptedAccessToken" TEXT NOT NULL,
    "encryptedRefreshToken" TEXT NOT NULL,
    "accessExpiresAt" TIMESTAMP(3) NOT NULL,
    "refreshExpiresAt" TIMESTAMP(3) NOT NULL,
    "login" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GithubUserToken_pkey" PRIMARY KEY ("userId")
);

-- CreateIndex
CREATE UNIQUE INDEX "GithubInstallation_installationId_key" ON "GithubInstallation"("installationId");

-- CreateIndex
CREATE INDEX "GithubInstallation_accountLogin_idx" ON "GithubInstallation"("accountLogin");

-- CreateIndex
CREATE INDEX "GithubInstallationAccess_installationId_idx" ON "GithubInstallationAccess"("installationId");

-- AddForeignKey
ALTER TABLE "GithubInstallationAccess" ADD CONSTRAINT "GithubInstallationAccess_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GithubInstallationAccess" ADD CONSTRAINT "GithubInstallationAccess_installationId_fkey" FOREIGN KEY ("installationId") REFERENCES "GithubInstallation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GithubUserToken" ADD CONSTRAINT "GithubUserToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
