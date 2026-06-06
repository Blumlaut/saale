-- AlterTable: replace responseInProgress boolean with processingSince timestamp
ALTER TABLE "ChatSession" DROP COLUMN "responseInProgress";
ALTER TABLE "ChatSession" ADD COLUMN "processingSince" TIMESTAMPTZ(3);
