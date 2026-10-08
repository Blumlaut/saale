-- IMAP UIDs are only unique within a mailbox, not within an account: INBOX and
-- Sent both number their messages from 1. Keying on (accountId, uid) made a Sent
-- message with UID 5 overwrite the INBOX message with UID 5 on the next sync.
DROP INDEX IF EXISTS "EmailMessage_accountId_uid_key";

CREATE UNIQUE INDEX IF NOT EXISTS "EmailMessage_accountId_folder_uid_key" ON "EmailMessage"("accountId", "folder", "uid");
