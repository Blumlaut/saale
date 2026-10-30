# Prompts

Reusable prompt templates a user sends as `/name` in any chat. A prompt is a row the
user owns, expanded on send so the stored message and the agent's input are the same
text. A coder chat also offers the templates its checkout carries in `.pi/prompts`,
which is where a project keeps instructions about itself.

## Decisions

- **One list per user, a scope per prompt.** `any` (the default), `chat`, or `coder`; a
  coder chat is the one with `projectId`. The composer, the send path and the `/` menu
  are shared by both surfaces, so a second list would duplicate the editor, the picker
  and the expansion to record a fact that belongs to one prompt.
- **Expanded before the message row is written.** The DB is the source of truth for a
  conversation and `message-rewind.ts` matches an edited message against the Pi
  transcript by content, so the stored text has to be the text the model got. The chat
  shows the expanded prompt.
- **Saale owns the substitution.** Pi exports `PromptTemplate` and `parseFrontmatter`
  and keeps `parseCommandArgs`/`substituteArgs` internal, so `substitute.ts` implements
  Pi's placeholders: `$1`, `$@`, `$ARGUMENTS`, `${1:-default}`, `${@:N}`, `${@:N:L}`,
  with shell-style quoting.
- **Pi's own expansion stays off.** `session.prompt(..., { expandPromptTemplates: true })`
  expands after persistence and dispatches extension commands and `/skill:` commands on
  the way, which would change behaviour for every plugin.
- **A project's templates come from the chat's own checkout.** Pi reads
  `<cwd>/.pi/prompts/*.md`, and a coder chat's cwd is its worktree, so a project's
  committed templates reach every coder chat of that project. Saale reads the directory
  itself (direct `.md` children, `description` and `argument-hint` from the frontmatter)
  because the composer lists them before any agent exists, and reads it per request so a
  template the agent commits shows up on the next message. A worktree is a fresh
  checkout, so the file has to be committed on the branch to be there at all.
- **Precedence: a catalog command, then the user's prompt, then the project's file.** A
  name the catalog already uses is refused when the prompt is saved. Between the two
  prompt sources the user's own wins, which is Pi's order: its global templates load
  before the project's and expansion takes the first match, so a repo cannot take a name
  the user relies on.
- **The picker inserts `/name `.** A catalog command runs on pick; a prompt lands at the
  caret so arguments can be typed, and expands on send. The menu re-reads the chat's
  prompts when it opens.
- **Expansion lives in the send path.** `POST /api/chat/sessions/:id/messages` and
  Telegram's processor both call `expandPromptInChat`, which leaves text alone unless it
  names one of the chat's prompts. A name no prompt answers to reaches the model as
  ordinary text, as before.
- **The editor is a Settings section.** A list plus an edit dialog, like Memories: name,
  description, what to type after the name, scope, prompt.
- **No starter prompts and no examples.** A new user starts with an empty list.

## Schema

```prisma
model Prompt {
  id           String   @id @default(cuid())
  userId       String
  name         String   @db.VarChar(40)   // [a-z0-9_-], what the parser reads
  description  String   @db.VarChar(100)
  argumentHint String?  @db.VarChar(100)  // Pi's `<required>` / `[optional]`
  scope        String   @default("any")   // "any" | "chat" | "coder"
  content      String   @db.Text
  user         User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt

  @@unique([userId, name])
  @@index([userId])
  @@map("Prompt")
}
```

## Where it lives

- `src/lib/prompts/`: rules (name, scope, reserved names), substitution, resolution and
  precedence, the project's template files, the store, and `expandPromptInChat`.
- `src/app/api/prompts`: the settings CRUD. `src/app/api/chat/sessions/[id]/prompts`:
  what the composer lists for one chat.
- `src/components/chat/`: the `/` menu items, the prompt pick, the per-chat fetch.
- `src/app/dashboard/settings/prompts`: the editor.

## Out of scope for now

- Listing a user's prompts in Telegram's `/` menu. They expand when typed; a TODO in
  `src/lib/telegram/client.ts` records the gap.
- Authoring per-project prompts in Saale. A project's prompts are files in its repo.
- Agent jobs referencing a prompt. `AgentDefinition.prompt` stays its own field.
