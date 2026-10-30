# Coder Panel

A second chat surface for code work. Same stream, same messages, same composer as
`/dashboard/chat`; the difference is that a coder chat belongs to a project, gets its
own git worktree on the first message, runs a coding-focused system prompt, and keeps a
right-hand panel with the branch, the changes and the worktree's files.

Projects are git repos inside the user's sandbox workspace. Every git command runs in
that user's container. The app never runs git on the host.

## Decisions

Settled in the kickoff conversation:

- **Workspace is the only filesystem.** Repos at `<workspace>/projects/<slug>`, worktrees
  at `<workspace>/worktrees/<project-slug>/<slug>`. Both are inside the workspace root the
  file tools and the file browser already serve, so nothing new needs to be reachable.
- **Execution home is the worktree.** A coder chat's agent cwd is its worktree, always: the
  worktree is built before a message is dispatched, so there is no fallback directory.
- **Projects come from `git init` or `git clone`.**
- **Auth is `gh` in the container.** A user sets `GH_TOKEN` as a sandbox environment
  variable and clones private repos with it; without one, public clones still work.
- **Every Saale user** gets the panel, not just an admin.
- **Worktree on the first message**, never at chat creation, so abandoned chats leave no
  empty worktrees behind.
- **One worktree per chat**, branch `wt/<slug>`.
- **No git tools.** The model uses the `bash` tool and the preinstalled git. The only git
  the app itself runs is bookkeeping: init, clone, worktree add/remove, status, diff, log.
- **Coder model purpose** with the normal fallback chain to the user's default model.
- **Own sidebar entry and pages**, `defaultHidden` like Council.
- **Tool defaults**: terminal, web and memory on; mail, calendar, jobs, contacts, chat
  search, infra, telegram, council and watchers off for new coder chats. The existing
  settings surface gains a coder section so a user can turn any of them back on.
- Right sidebar with branch, changes and a file browser. No editor. A terminal comes after
  the core lands.

## What we take from `~/pi-workspace` (ammit)

These get read as reference. Saale runs in-process Pi sessions in a per-user container, so
the shapes are copied and the plumbing written fresh.

- `server/git.ts`: `git worktree list --porcelain` parsing, `worktree add`/`remove`, the
  `--force`-less removal rule, `GIT_TERMINAL_PROMPT=0` on every call.
- `server/projects.ts`: clone/init, `DEFAULT_GITIGNORE`, the 10-minute clone timeout, the
  slug rules.
- `server/workspace-cleanup.ts`: delete only when git proves nothing is left behind, and a
  refusal that is shown verbatim instead of retried with force.
- `docs/workspaces.md` + `docs/git.md`: worktrees are the unit a chat runs in, removal is
  git's decision, the registry and git are never allowed to disagree.

## Schema

```prisma
model CoderProject {
  id            String   @id @default(cuid())
  userId        String
  name          String   @db.VarChar(100)
  slug          String   @db.VarChar(100)
  /// Workspace-relative repo dir, e.g. "projects/saale-web".
  repoPath      String
  originUrl     String?
  defaultBranch String   @default("main")
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
  user          User          @relation(fields: [userId], references: [id], onDelete: Cascade)
  chats         ChatSession[]
  worktrees     CoderWorktree[]

  @@unique([userId, slug])
  @@index([userId])
  @@map("CoderProject")
}

model CoderWorktree {
  id        String    @id @default(cuid())
  projectId String
  /// The chat this worktree belongs to. one worktree per chat.
  sessionId String    @unique
  /// Workspace-relative, e.g. "worktrees/saale-web/c-1a2b3c4d".
  path      String
  branch    String
  /// Commit the branch started from, for the ahead count.
  baseSha   String
  status    String    @default("active") // "active" | "removed"
  removedAt DateTime?
  createdAt DateTime  @default(now())
  project   CoderProject @relation(fields: [projectId], references: [id], onDelete: Cascade)
  session   ChatSession  @relation(fields: [sessionId], references: [id], onDelete: Cascade)

  @@index([projectId])
  @@map("CoderWorktree")
}
```

`ChatSession` gains `projectId String?` (relation + `@@index([projectId, lastActivityAt])`).
A session with a `projectId` is a coder chat; `null` is a normal chat, so
`GET /api/chat/sessions` keeps its current list by filtering `projectId: null`.

`AppSettings` gains `coderToolConfig Json?`, the same shape as `defaultToolConfig`.

The worktree row holds the path, so a chat is not tied to a directory string. Removal order
is directory first, then the row: a failed `git worktree remove` leaves a row we can retry
instead of an orphaned directory nobody knows about.

## Filesystem

```
<workspace>/                      # /workspaces/user-<id>, mounted in the container
  .gitconfig                      # identity, init.defaultBranch, safe.directory
  projects/<slug>/                # the repo
  worktrees/<project-slug>/<slug>/# one per coder chat
```

Everything is created and touched **inside the container** (`sandboxExec`), so the repo,
the objects and the worktree all belong to the sandbox account. The app writes nothing
here except by going through the same exec path.

## Execution model

- All git work goes through `src/lib/coder/git.ts`, one `sandboxExec` per logical step,
  cwd set to the repo or the worktree, `GIT_TERMINAL_PROMPT=0`, `--no-pager`, and a
  timeout on clones only (10 minutes, as ammit does).
- The status sidebar reads git through the same helper, so what the panel shows and what
  the model commits cannot describe different trees.
- `.gitconfig` is written once per workspace (before the first project): `user.name` /
  `user.email` from the `User` row, `init.defaultBranch = main`, `safe.directory` for the
  workspace root, `pull.ff = only`. Without an identity, `git commit` fails inside the
  container and the model would waste a turn discovering it.
- `git` and `gh` are already in `Dockerfile.sandbox`. A test asserts both stay there; the
  project-create route reports the container's `git --version` when it fails.

## First message → worktree

A pooled agent exists only once a message is being prompted: `prepareRun` in the stream
route claims the message and calls `ensureChatAgent`, and the telegram/respond-in-chat
paths go through the same helper.

```
claim message
  → ensureChatAgent
      coder chat   → ensureWorktree(chat)     # idempotent, single-flight per session
                       row exists, dir exists → nothing
                       row exists, dir gone   → recreate at the same path, same branch
                       no row                 → git worktree add -b wt/<slug> <dir> <defaultBranch>
                                                record { path, branch, baseSha }
      chat         → nothing
  → build the session with cwd = worktree (coder) / workspace (chat)
  → prompt
```

- The worktree lives in `ensureChatAgent`, so no entry point can build a coder agent
  without one, and a coder session's cwd is never anything but its worktree.
- `ensureWorktree` is serialized per project (an in-process mutex), and retries once on a
  git lock error.
- A failed worktree creation fails the turn with git's stderr and nothing is prompted. A
  chat whose worktree cannot be built must not run in the repo and commit there by
  accident.
- Creating or recreating a worktree evicts that session's pooled agent, since the cwd is
  baked into it.
- `git worktree add` takes the project's `defaultBranch`. The repo is not fetched on chat
  creation, so a clone-and-work flow costs one `git fetch` the model runs itself.

## Agent session

`agent-session.ts` refuses a caller-supplied cwd today, and that rule stays: the caller
passes a **workspace-relative** path, and `resolveAgentCwd(userId, relative?)` runs it
through `requireWithinRoot(workspace, ...)`. An app path or a `..` escape throws.

- `createSaaleAgentSession(userId, options)` gains an optional `workspaceCwd`.
- `createPersistentSession` passes it through.
- `createChatAgentSession` resolves it: worktree path for a coder chat, nothing otherwise.
- Other callers (jobs, telegram, council, email drafts) are untouched and keep the
  workspace cwd.
- Pool key stays `userId:sessionId`; the entry is evicted whenever the worktree changes.

## Prompt

`src/lib/pi/coder-prompt.ts` builds the coder prompt:

- Identity: a coding agent working in one worktree of one project. The worktree is the
  whole of its filesystem authority; every other path is out of bounds.
- Git discipline: commit as work lands, in small commits, imperative subject lines under
  50 characters, no attribution trailers, run the project's own checks before committing,
  never `--force`, never push unless asked, never touch other branches or worktrees, never
  rewrite history that exists on a remote.
- Reporting: finish a turn with what changed, what is committed, and what is left dirty.
- Reuses the capability sections (`processing-state.ts` exports its section builder) so a
  coder session with the terminal category enabled gets the same bash/files contract a
  chat does, and a session without it does not describe tools it cannot call.
- `GH_TOKEN` is mentioned only when the user has one configured, alongside the existing
  sandbox env-name listing (`names`, never values).

`ChatSession.customInstructions` still applies, appended after the identity block.

## Settings

- `MODEL_PURPOSES` gains `coder` ("Coder", "Code work in a project worktree"). Resolution
  order is unchanged: coder override → user default → admin default.
- `AppSettings.coderToolConfig` is the default category on/off map for new coder chats.
  `src/lib/settings/properties.ts` derives `coder.tools.category.<key>.enabled` from
  `TOOL_CATEGORIES` (its defaults come from a new `CODER_TOOL_DEFAULTS` in
  `src/lib/pi/coder-tools.ts`), so the coverage test and the settings API pick it up.
- Exposure is shared with chat (`toolExposure`) in this version. Only on/off is split.
- A new coder section on the settings page renders those toggles plus the model purpose.

## API

```
GET    /api/coder/projects                     list: slug, name, branch, worktree count, last activity
POST   /api/coder/projects                     { name, cloneUrl?, authFromEnv? } → init or clone
GET    /api/coder/projects/:id                 project + its chats + their worktree state
DELETE /api/coder/projects/:id                 removes worktrees first (see Cleanup)
GET    /api/coder/projects/:id/changes         branch, ahead/behind, changed files, recent commits
GET    /api/coder/sessions/:sessionId/diff     ?path=&staged=   unified diff text
GET    /api/coder/sessions/:sessionId/status   worktree state for the right panel
POST   /api/coder/sessions/:sessionId/terminal       start a command in the worktree
GET    /api/coder/sessions/:sessionId/terminal/stream  SSE: the chat's run, replayed then live
POST   /api/coder/sessions/:sessionId/terminal/stop    stop that run
POST   /api/coder/sessions/:sessionId/terminal/input   type into it
POST   /api/coder/sessions/:sessionId/terminal/resize  tell the run how big the panel is
```

Every route authenticates, then scopes by `project.userId` / `session.userId` in the
`where` clause, and re-checks that the resolved path is inside the user's workspace before
it reaches git. Coder chat creation goes through the existing
`POST /api/chat/sessions` with `projectId`, so one code path builds both kinds of session.

## UI

Route shape mirrors chat: `layout.tsx` reads the path, the pages exist for routing only.

```
/dashboard/coder                         project list (+ New project)
/dashboard/coder/[projectId]             project's coder chats
/dashboard/coder/[projectId]/[sessionId] the chat
```

The chat page is three columns on desktop:

- **Left**: `SessionSidebar` scoped to the project (it already takes a session list), with
  the branch under each row once a worktree exists.
- **Center**: `ChatInterface`, unchanged. Same composer, same tool cards, same approvals.
- **Right**: a `GlassPanel` with three tabs.
  - **Changes**: branch, ahead/behind, changed files with `+n/−n`, stage and unstaged
    groups, recent commits. A row opens the unified diff in a scroll box.
  - **Files**: the existing `FileBrowser`, given a `rootPath` prop so it starts in the
    worktree.
  - **Terminal** (later): command runner in the worktree.

The right panel refreshes when the generation ends: the page watches the session's
`isGenerating` via the existing `useStreamingSessions` hook, plus a manual refresh.

Mobile: the right panel becomes a sheet from the header (registered in
`e2e/modal-scenarios.ts`), the project list replaces the left column, and the chat keeps
its full-bleed treatment. Long paths and branch names wrap (`break-all`) rather than
scroll the panel.

Nav: `coder` in `SIDEBAR_NAV_ITEMS` with `defaultHidden: true`, and a `coder` key in
`FEATURES` (`navId: "coder"`, `toolCategories: ["terminal"]`) so the admin can switch the
module off.

Diff rendering is a `<pre>` of the unified diff with line tints: added lines green, removed
lines red, hunk headers muted. No Monaco.

## Cleanup

Deleting a coder chat asks first, then removes the worktree. The chat is deleted only when
that succeeds.

```
stop running processes in the worktree     pkill -f <worktree path> in the container
git worktree remove <dir>                  no --force
  → refuses (dirty tree, missing repo)     error shown verbatim, chat stays
  → success                                CoderWorktree.status = "removed", then delete the chat
```

- The confirmation names the branch and the dirty file count, so the choice is informed.
  The branch and its commits stay in the repo; only the checkout goes.
- A failed removal keeps the chat and its worktree. Nothing offers a half-delete.
- Deleting a project removes each worktree the same way, then the repo directory only when
  git proves it is clean and fully pushed (`workspace-cleanup.ts` rules). Refused while any
  of its chats is generating.
- A worker sweep (daily, alongside the existing task runner) removes `CoderWorktree` rows
  whose directory is gone, prunes `git worktree` metadata, and logs directories under
  `worktrees/` that no row claims. It never deletes a directory git still tracks.
- Processes: a terminal command belongs to the chat, not to the panel: it keeps running when
  the panel closes, and reopening the chat replays what it printed. Its exec id is recorded, so
  worktree removal kills it (then `pkill -f` on the worktree path for anything a background
  command left: dev servers, watchers). A stopped-by-cleanup exec reads as "exited".
- A terminal command runs on a pty (`Tty` on the docker exec, `script` on the dev host) with
  `TERM` set, so full-screen programs work, and the panel draws the output through xterm.js.
  The size travels with the start and can change while the command runs; the dev host's pty
  keeps the size it started with.
- Archived chats do not exist in Saale today. When one is added, the worktree
  removal belongs at the same hook as chat deletion.

## Git actions

The panel is a git client, not a viewer. Everything below goes through
`src/lib/coder/actions.ts`, one `POST /api/coder/sessions/:id/git` with an action name and
nothing about where: the checkout comes from the chat's row, and every path and branch name
is checked before it reaches a command.

```
fetch                       git fetch --prune --all
pull                        git pull --ff-only, or --rebase from the menu
push                        git push, or push --set-upstream origin <branch>
commit                      git commit -m <message> [--amend], optionally then push
stage / unstage             git add -- <paths> | --all, git restore --staged | reset
discard                     restore --source=HEAD --staged --worktree, clean --force for untracked
branch                      git switch <name> | switch --create <name>
stash / stash-pop           stash push --include-untracked, stash pop
undo-commit                 git reset --soft HEAD~1
```

- One writer per repo: the same lock `ensureWorktree` takes, keyed by project id, so a push
  from a button never overlaps a `worktree add` for another chat.
- Network commands carry the user's `GH_TOKEN` as a one-shot `credential.helper`, so a private
  remote works without the token reaching `.gitconfig`. A user who ran `gh auth login` has a
  helper of their own and needs nothing from Saale.
- `--force` is never passed. A pull is fast-forward or rebase, decided by the button, never
  by git's defaults.
- The panel splits the change list into staged and changes, the way a commit sees them: a path
  is one or both. Conflicts get their own letter, because a worktree that needs a decision
  should not look like an edit.
- History marks the commits above the branch's upstream, and draws the upstream's name where
  they stop. `?commits=` raises the read a page at a time.
- `gh pr view` / `gh pr create --fill` give the branch its pull request badge and a way to
  open one, read on its own endpoint so the status poll never pays a network round trip.

## Steps

Each step is a commit that leaves `npm run check` green.

1. **Schema.** `CoderProject`, `CoderWorktree`, `ChatSession.projectId`,
   `AppSettings.coderToolConfig` + the registry property. One migration, all additions
   (follow `.pi/skills/database-migrations`).
2. **Paths and gitconfig.** `src/lib/coder/paths.ts`, `slug.ts`, `gitconfig.ts`, plus
   tests for slug rules, workspace confinement and the gitconfig body.
3. **Git helpers.** `src/lib/coder/git.ts` (run, init, clone, worktree add/remove, status,
   numstat, diff, log) over `sandboxExec`, and `git-status.ts` parsers with fixture tests
   taken from real porcelain output.
4. **Projects API.** `src/lib/coder/projects.ts` + the routes, with tests for init, clone,
   duplicate slug, and a refusal to create outside `projects/`.
5. **Cwd plumbing.** `agent-session.ts`, `persistent-session.ts`, `chat-session-factory.ts`
   take a workspace-relative cwd; tests cover accepted and rejected paths.
6. **Worktree on first message.** `src/lib/coder/worktrees.ts` (`ensureWorktree`), called
   from `ensureChatAgent` before the pooled session is built; pool eviction on change;
   tests for idempotency and for the no-row/row-without-dir cases.
7. **Prompt, tools, model.** `coder-prompt.ts`, `CODER_TOOL_DEFAULTS`, the `coder` purpose,
   and the settings toggles. Tests assert the git rules are present and that a disabled
   category's section is absent.
8. **Nav and project list.** Sidebar item, feature key, `/dashboard/coder`, create dialog,
   delete flow.
9. **Chat page.** Center chat + right panel (branch, changes, diff, files), the
   `FileBrowser` `rootPath` prop, mobile sheet, `modal-scenarios` entries.
10. **Cleanup.** Chat-delete worktree removal with confirmation, project delete, the
    worker sweep, process kill; tests for the dirty-tree refusal and the sweep.
11. **Terminal** (follow-up): a `POST /api/coder/sessions/:id/terminal` stream over
    `sandboxExec`. Typing into a command that is already running needs `/exec/:id/input`, and
    a program that draws a screen needs `/exec/:id/resize` and `tty` on the exec.
12. **E2E.** `e2e/coder-panel.spec.ts`: create a project from `git init`, send a message,
    assert a worktree appears, edit a file through the file browser, see the change list
    update, delete the chat and see the worktree go. Plus the 375px and 320px overflow
    checks for the new pages.

## Tests

Real behaviour:

- `git-status.ts` parses staged, unstaged, untracked, renamed and conflicted trees.
- `ensureWorktree` is idempotent; two chats in one project get distinct branches and
  directories; a missing directory is recreated on the same branch.
- A dirty worktree refuses removal, the route reports the reason, and the chat survives.
- `resolveAgentCwd` accepts `worktrees/x/y` and rejects `../other`, `/etc`, and a path in
  another user's workspace.
- The coder prompt contains the commit rules and omits the section for a disabled category.
- Project creation with a `GH_TOKEN` in sandbox env clones a private repo (mocked exec);
  without one it fails with git's message rather than hanging.
- Settings coverage test picks up `coderToolConfig`; the coder purpose resolves, falls back
  to the user default, then the admin default.
- Chat list route keeps coder chats out of `/dashboard/chat`.

## Risks

- **Disk.** A worktree with its own `node_modules` is expensive. The project list shows the
  total size of `worktrees/` per project and offers "remove finished worktrees"; a cap is a
  follow-up decision.
- **Cold container.** The first git call after the sandbox container is reaped pays a
  container start. The panel shows a loading state and never blocks the chat on it.
- **Ownership.** Directories the app creates are root-owned. Every project and worktree
  directory is created through the container, and `safe.directory` covers the volume.
- **Ordering.** Deleting a chat removes the directory before the row, so a failed removal
  stays visible and retryable instead of silently orphaning a checkout.
- **Pooled cwd.** A stale agent cwd is a wrong-directory commit. Any worktree change evicts
  the pooled session, and the factory re-reads the row on every rebuild.
- **Prompt drift.** The coder prompt and the chat prompt share one section builder, so a
  new tool category cannot describe itself in one and stay silent in the other.

## Out of scope

Monaco or any editor, merging worktrees back, per-worktree disk quotas, importing a zip as a
project, and ammit's LSP, forge and routines panels.
