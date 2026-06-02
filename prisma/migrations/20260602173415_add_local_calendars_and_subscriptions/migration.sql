-- DropIndex
DROP INDEX "CalendarAccount_userId_username_serverUrl_key";

-- AlterTable
ALTER TABLE "CalendarAccount" ADD COLUMN     "accountType" TEXT NOT NULL DEFAULT 'caldav',
ALTER COLUMN "serverUrl" DROP NOT NULL,
ALTER COLUMN "username" DROP NOT NULL,
ALTER COLUMN "username" SET DEFAULT '',
ALTER COLUMN "encryptedPassword" DROP NOT NULL;

-- CreateTable
CREATE TABLE "CalendarSubscription" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "calendarId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "username" TEXT,
    "password" TEXT,
    "etag" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CalendarSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CalendarSubscription_userId_idx" ON "CalendarSubscription"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "CalendarSubscription_calendarId_url_key" ON "CalendarSubscription"("calendarId", "url");

-- CreateIndex
CREATE INDEX "CalendarAccount_userId_accountType_idx" ON "CalendarAccount"("userId", "accountType");

-- AddForeignKey
ALTER TABLE "CalendarSubscription" ADD CONSTRAINT "CalendarSubscription_calendarId_fkey" FOREIGN KEY ("calendarId") REFERENCES "Calendar"("id") ON DELETE CASCADE ON UPDATE CASCADE;
