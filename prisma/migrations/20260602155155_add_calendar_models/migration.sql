-- AlterTable
ALTER TABLE "EmailMessage" ADD COLUMN     "calendarScanned" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "CalendarAccount" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "serverUrl" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "encryptedPassword" TEXT NOT NULL,
    "authMethod" TEXT NOT NULL DEFAULT 'basic',
    "tokenUrl" TEXT,
    "clientId" TEXT,
    "refreshToken" TEXT,
    "accessToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CalendarAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Calendar" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "remoteId" TEXT,
    "name" TEXT NOT NULL,
    "color" TEXT,
    "description" TEXT,
    "readOnly" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastSyncedAt" TIMESTAMP(3),
    "ctag" TEXT,
    "syncToken" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Calendar_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CalendarEvent" (
    "id" TEXT NOT NULL,
    "calendarId" TEXT NOT NULL,
    "uid" TEXT NOT NULL,
    "summary" TEXT NOT NULL DEFAULT '(no title)',
    "description" TEXT,
    "location" TEXT,
    "url" TEXT,
    "status" TEXT,
    "transparency" TEXT,
    "sequence" INTEGER NOT NULL DEFAULT 0,
    "dtStart" TIMESTAMP(3) NOT NULL,
    "dtEnd" TIMESTAMP(3),
    "allDay" BOOLEAN NOT NULL DEFAULT false,
    "timeZone" TEXT,
    "recurrenceRule" TEXT,
    "recurrenceDateIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "exceptionDateIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "alerts" TEXT,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "sourceEmailId" TEXT,
    "etag" TEXT,
    "lastModified" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CalendarEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CalendarAccount_userId_idx" ON "CalendarAccount"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "CalendarAccount_userId_username_serverUrl_key" ON "CalendarAccount"("userId", "username", "serverUrl");

-- CreateIndex
CREATE INDEX "Calendar_accountId_idx" ON "Calendar"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "Calendar_accountId_remoteId_key" ON "Calendar"("accountId", "remoteId");

-- CreateIndex
CREATE INDEX "CalendarEvent_calendarId_dtStart_idx" ON "CalendarEvent"("calendarId", "dtStart");

-- CreateIndex
CREATE INDEX "CalendarEvent_dtStart_idx" ON "CalendarEvent"("dtStart");

-- CreateIndex
CREATE UNIQUE INDEX "CalendarEvent_calendarId_uid_key" ON "CalendarEvent"("calendarId", "uid");

-- AddForeignKey
ALTER TABLE "CalendarAccount" ADD CONSTRAINT "CalendarAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Calendar" ADD CONSTRAINT "Calendar_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "CalendarAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalendarEvent" ADD CONSTRAINT "CalendarEvent_calendarId_fkey" FOREIGN KEY ("calendarId") REFERENCES "Calendar"("id") ON DELETE CASCADE ON UPDATE CASCADE;
