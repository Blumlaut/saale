-- Where a subscription lives, so a phone's copy of a notification can wait for
-- a computer to see it first. Existing rows read as computers: they get their
-- notifications at once, exactly as before.

ALTER TABLE "PushSubscription" ADD COLUMN IF NOT EXISTS "deviceKind" TEXT NOT NULL DEFAULT 'desktop';
