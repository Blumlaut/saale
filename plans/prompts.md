# Prompts

Reusable prompt templates a user invokes as `/name` in any chat. One list per user,
stored in the database, expanded on send so the model and the transcript hold the same
text.

## Decisions

Settled in the kickoff conversation:

- **One list per user, a scope per prompt.** `any` (the default), `chat`, or `coder`; a
  coder chat is the one with `projectId`. The composer, the send path and the `/` menu are
  already shared by both surfaces (`src/components/chat/input-bar.tsx`,
  `src/app/api/chat/sessions/[sessionId]/messages/route.ts`), so a second list would
  duplicate the editor, the picker and the expansion to record something that belongs to
  one prompt.
- **Expanded before the message row is created.** The DB is the source of truth for the
  conversation and `message-rewind.ts` matches an edited message against the Pi
  transcript by content, so the stored text has to be the text the model got. The chat
  shows the expanded prompt.
- **Saale owns the substitution.** Pi exports `PromptTemplate` and `parseFrontmatter` and
  keeps `parseCommandArgs`/`substituteArgs` internal (the package has no deep import
  paths), so `src/lib/prompts/` implements Pi's syntax: `$1`, `$@`, `$ARGUMENTS`,
  `${1:-default}`, `${@:N}`, `${@:N:L}`, with shell-style quoting.
- **Pi's own expansion stays off.** `session.prompt(..., { expandPromptTemplates: true })`
  expands after persistence and dispatches extension commands and `/skill:` commands on
  the way, which would change behaviour for every plugin.
- **Project prompts come from the chat's own checkout.** Pi reads
  `<cwd>/.pi/prompts/*.md`, and a coder chat's cwd is its worktree, so a project's
  committed templates reach every coder chat of that project. Saale reads the directory
  itself (direct `.md` children, `description` and `argument-hint` from the frontmatter)
  because the composer needs the list before any agent exists. `project-context.ts`
  already reads `.pi/skills` the same way.
- **Precedence: a catalog command, then the user's prompt, then the project's file.** A
  name the catalog already uses is refused when the prompt is saved. Between the two
  prompt sources the user's own wins, which is Pi's order: its global templates load
  before the project's and expansion takes the first match, so a repo cannot take a name
  the user relies on.
- **The picker inserts `/name `.** A catalog command runs on pick, as it does today; a
  prompt lands at the caret so arguments can be typed, and expands on send.
- **Expansion lives in the messages route and the Telegram run path.** Both already parse
  `/name args` and hand names they do not know to the model, so a prompt needs no new
  syntax. The bot menu keeps the catalog commands and prompts stay typeable; a TODO in
  `src/lib/telegram/client.ts` records the gap.
- **The editor is a Settings section.** A list plus an edit dialog, like Memories: name,
  description, argument hint, scope, content.
- **No starter prompts and no examples.** A new user starts with an empty list.

## Schema

```prisma
model Prompt {
  id           String   @id @default(cuid())
  userId       String
  /// `/name`, the parser's charset: [a-z0-9_-]
  name         String   @db.VarChar(40)
  description  String   @db.VarChar(100)
  /// Shown after the name in the composer, Pi's convention: <required> [optional]
  argumentHint String?  @db.VarChar(100)
  /// "any" | "chat" | "coder"
  scope        String   @default("any")
  content      String   @db.Text
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt

  @@unique([userId, name])
  @@index([userId])
  @@map("Prompt")
}
```

## Reading a project's templates

Direct `.md` children of `<chat cwd>/.pi/prompts`, read per request so a file the agent
writes mid-chat shows up on the next menu open. A worktree is a fresh checkout, so a
project's template has to be committed on the branch to exist there at all.

## Out of scope for now

- Listing a user's prompts in Telegram's `/` menu.
- Authoring per-project prompts in Saale. A project's prompts are files in its repo.
- Agent jobs referencing a prompt. `AgentDefinition.prompt` stays its own field.
