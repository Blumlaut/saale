-- A chat created from the UI was stored with the "New Chat" placeholder and
-- titleSource "user", so nothing ever named it. Free those rows for naming.
UPDATE "ChatSession" SET "titleSource" = 'default'
WHERE "titleSource" = 'user' AND "title" = 'New Chat';
