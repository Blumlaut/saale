-- Custom instructions for coder chats, kept apart from the chat persona so a
-- coder session can carry its own guidance without changing chat behaviour.
ALTER TABLE "AppSettings" ADD COLUMN IF NOT EXISTS "coderCustomInstructions" TEXT;
