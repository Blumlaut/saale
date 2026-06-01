-- Replace aiTags (String[]) with classified (Boolean)
ALTER TABLE "EmailMessage" DROP COLUMN "aiTags";
ALTER TABLE "EmailMessage" ADD COLUMN "classified" BOOLEAN NOT NULL DEFAULT false;
