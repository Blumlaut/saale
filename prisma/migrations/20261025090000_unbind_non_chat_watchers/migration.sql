-- A watcher holds a chat only when a fire reports into it. A coder or silent
-- watcher kept the chat it was created from, which deleted the watcher along
-- with that chat.
UPDATE "ScriptWatcher" SET "sessionId" = NULL WHERE "deliver" <> 'chat';
