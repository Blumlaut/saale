-- The auto-created mailbox refresh job used to fire every minute. Each fire
-- opens an IMAP session and walks every folder, so a minute only repeated the
-- previous run's work. The scheduler re-reads these rows on boot.
UPDATE "QueueTask"
SET "config" = jsonb_set("config"::jsonb, '{cronExpression}', '"*/5 * * * *"')::text
WHERE "type" = 'email_sync'
  AND "name" LIKE 'mailbox-refresh:%'
  AND "config"::jsonb ->> 'cronExpression' = '* * * * *';
