# Council

A room of named agents. each with its own model. that work one goal together.

A council has a **brief** (what it is for) and **members** (name, model, optional
role, optional tool overrides). The owner speaks into the room; members speak
only through a `council_post` **tool call**, so every message in the room was a
deliberate act rather than a turn's closing text. When a member posts, the
members it addresses are woken and run. in parallel, or one at a time in
round-robin mode. Each member keeps its own private reasoning, tool calls and
unsent closing text, all of which the owner can read on that member's subpage.

A run ends when a stop vote reaches quorum, a budget (wall clock / tokens /
cost) trips, the owner stops it, a member asks the owner a question (the run
pauses), or the room simply goes quiet.

## The pieces

| File              | What it is                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------------ |
| `flag.ts`         | `COUNCIL_ENABLED`. the module-level switch                                                       |
| `access.ts`       | Who may use it (admins only); 404 otherwise                                                      |
| `config.ts`       | Limits, defaults, quorum maths, orchestration and threshold vocabularies                         |
| `mentions.ts`     | `@name` / `@all` / `@user` parsing and resolution                                                |
| `names.ts`        | The bundled wordlist a member's name is drawn from when the field is left blank                  |
| `accounts.ts`     | council → sandbox key → Open Terminal account                                                    |
| `commands.ts`     | One-shot terminal commands (account lookup, account deletion)                                    |
| `sandbox.ts`      | The council's confined file operations and workspace lifecycle                                   |
| `files.ts`        | The council's workspace as a file-browser target (admin gate, sandbox identity)                  |
| `room.ts`         | The room's read model (one shape for tools, prompts, loop and UI)                                |
| `prompt.ts`       | The member's system prompt and each turn's prompt                                                |
| `tools.ts`        | `council_post`, `council_read`, `council_vote_stop`                                              |
| `session.ts`      | One member's Pi session for one run (its workspace and nothing else, unless the council opts in) |
| `orchestrator.ts` | The run loop: scheduling, budgets, votes, the private transcript of each turn                    |
| `persist.ts`      | The loop's writes (messages, runs, turns, heartbeat)                                             |
| `store.ts`        | CRUD and reads for the API and the room UI                                                       |
| `run.ts`          | Starting, stopping and sweeping runs                                                             |
| `events.ts`       | The live channel (the chat stream's Redis bus, keyed by council id)                              |
| `abort.ts`        | The stop flag an in-flight run polls                                                             |
| `schema.ts`       | Request validation (zod)                                                                         |
| `http.ts`         | Shared route plumbing (session, access, body, error mapping)                                     |

Routes live in `src/app/api/council/`, the UI in `src/app/dashboard/council/`
and `src/components/council/`.

## The sandbox

Each council gets a **dedicated Open Terminal account**. The council's key is
passed as `X-User-Id`, which Open Terminal maps to its own Linux user whose home
is the `council-<key>` directory of the workspaces volume. That is the boundary:
a council cannot read the owner's workspace and the owner cannot read the
sandbox, because the container mounts only its own directory.

On top of it:

- **Path confinement** (`sandbox.ts`). every path a file tool is handed is
  normalised and refused when it leaves the sandbox, then resolved through
  `realpath` again by the provider, so a symlink cannot reach another tenant.
- **The mount check** (`src/sandbox/mount-check.ts`). a new container's
  `/proc/self/mountinfo` must show exactly the council's own directory, or the
  container is destroyed and the request fails. The preflight
  (`ensureCouncilSandbox`) creates the directory and checks the service answers.
- **No credentials of their own**. no MCP servers, no variables beyond the
  owner's sandbox variables, which members act with.
- **Excluded tools**. `show_file` (reads a file the owner uploaded to a chat)
  and the chat-history tools are removed from a member's session whatever the
  council's tool selection says.

Known limits, honestly:

- Deleting a council removes its container and its directory (`rm -rf` plus a
  Docker removal), so nothing of the sandbox is left behind.
- Deleting a council does not stop a run that is in flight. stop it first. The
  run's writes then fail (its directory is gone) and are logged.
- A tenant container has its own `/tmp` and `/proc`; the other councils' and
  users' directories are absent from it.
- The workspace is browsable. `/dashboard/council/<id>/files` opens the same
  reusable file browser a user's own files will use, pointed at the council's
  sandbox root: list, preview, upload, download, multi-select zips, rename,
  delete. It runs as the sandbox identity, so it sees exactly what a member
  sees and nothing else (`src/lib/files/`).
- A run is declared abandoned by the sweep when it has not heartbeated for 90s.
  The heartbeat is a timer (15s), so a process whose event loop is blocked for
  longer than that could have a live run marked failed. Nothing in a council
  blocks the loop that long; the run is recoverable (start it again) and the
  record says `timeout`.
- Stop and the budgets never wait for `session.abort()` to resolve. It resolves
  only once the agent is idle, and a turn stuck in a tool that ignores the abort
  signal. or a provider stream that never closes after the server went away
  keeps it busy indefinitely. The run ends on its own decision and lets the
  abort land in the background. A turn that is completely silent (no tokens, no
  thinking, no tool activity) for 10 minutes is ended as a failed turn by the
  idle guard, so a hung provider cannot keep a run alive between budgets.

## Two switches

- **`COUNCIL_ENABLED=0`** removes the module: the sidebar entry, the routes (404)
  and the tools.
- **Admins only.** `requireCouncilAccess` refuses everyone else with the same
  404, because parallel models against the owner's provider keys and a shared
  workspace in the terminal container is not something every account should turn
  on. The nav entry is also `defaultHidden`, so it is opt-in even for an admin.

## Ripping it out

Nothing outside the module depends on it. To remove the feature:

1. Delete `src/lib/council/`, `src/components/council/`,
   `src/app/api/council/`, `src/app/dashboard/council/`,
   `src/types/council.ts`, `__tests__/lib/council/`, `__tests__/api/council/` and
   the council entries in `e2e/`.
2. `src/lib/navigation/sidebar-nav.ts`. drop `"council"` from
   `SIDEBAR_NAV_ITEM_IDS` and the definitions map (`defaultHidden` itself is
   generic and can stay).
3. `src/components/layout/sidebar-nav-icons.ts`. drop the `council` icon.
4. `src/app/api/settings/sidebar-nav/route.ts`. drop `unavailableNavIds`/`restrict`
   (or the whole council branch).
5. `src/lib/queue/index.ts`. drop `COUNCIL_SWEEP_*` and `scheduleCouncilSweep`;
   `src/lib/queue/worker.ts`. drop the router branch, the scheduler call and the
   `isCouncilEnabled` import; `src/app/api/council/execute/route.ts` goes with
   step 1.
6. `src/lib/terminal/client.ts`. `executeContainerCommand` is only used by the
   council's account cleanup.
7. Prisma: drop the `// ─── Council ───` models, the `councils` back-relation on
   `User`, and generate a migration.
8. `e2e/modal-scenarios.ts`. drop the council scenarios.
9. `docker-compose.yml` and `.env.example`. drop the `COUNCIL_ENABLED` entries.

`src/lib/files/` and `src/components/files/` are **not** part of the module and
stay: they are a generic workspace browser. Only two things in them are
council-aware. the `council:` branch in `src/lib/files/request.ts` (and its
import of `src/lib/council/files.ts`) and the page under
`src/app/dashboard/council/<id>/files/`.

## Tests

`__tests__/lib/council/` covers the pieces that can be wrong quietly: mention
parsing, quorum maths, budget resolution, name drawing, sandbox path confinement
and account derivation, the room tools, the loop's scheduling (mentions, votes,
budgets, stop conditions, round-robin, mid-run steering, failure isolation), turn
transcripts, persistence, and the run lifecycle. `__tests__/api/council/` covers
the message route (handles, busy runs, the access gate). The UI's own behaviour
is covered by `__tests__/components/council/` and the e2e specs at 375px/320px.
