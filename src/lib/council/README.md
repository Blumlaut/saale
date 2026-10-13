# Council

A room of named agents — each with its own model — that work one goal together.

A council has a **brief** (what it is for) and **members** (name, model, optional
role, optional tool overrides). The owner speaks into the room; members speak
only through a `council_post` **tool call**, so every message in the room was a
deliberate act rather than a turn's closing text. When a member posts, the
members it addresses are woken and run — in parallel, or one at a time in
round-robin mode. Each member keeps its own private reasoning, tool calls and
unsent closing text, all of which the owner can read on that member's subpage.

A run ends when a stop vote reaches quorum, a budget (wall clock / tokens /
cost) trips, the owner stops it, a member asks the owner a question (the run
pauses), or the room simply goes quiet.

## The pieces

| File            | What it is                                                                                        |
| --------------- | ------------------------------------------------------------------------------------------------- |
| `flag.ts`       | `COUNCIL_ENABLED` — the module-level switch                                                        |
| `access.ts`     | Who may use it (admins only); 404 otherwise                                                        |
| `config.ts`     | Limits, defaults, quorum maths, orchestration and threshold vocabularies                            |
| `mentions.ts`   | `@name` / `@all` / `@user` parsing and resolution                                                 |
| `names.ts`      | The bundled wordlist a member's name is drawn from when the field is left blank                    |
| `accounts.ts`   | council → sandbox key → Open Terminal account                                                      |
| `commands.ts`   | One-shot terminal commands (account lookup, account deletion)                                      |
| `sandbox.ts`    | The council's confined file operations and workspace lifecycle                                     |
| `room.ts`       | The room's read model (one shape for tools, prompts, loop and UI)                                  |
| `prompt.ts`     | The member's system prompt and each turn's prompt                                                  |
| `tools.ts`      | `council_post`, `council_read`, `council_vote_stop`                                                |
| `session.ts`    | One member's Pi session for one run                                                                |
| `orchestrator.ts` | The run loop: scheduling, budgets, votes, the private transcript of each turn                    |
| `persist.ts`    | The loop's writes (messages, runs, turns, heartbeat)                                               |
| `store.ts`      | CRUD and reads for the API and the room UI                                                         |
| `run.ts`        | Starting, stopping and sweeping runs                                                               |
| `events.ts`     | The live channel (the chat stream's Redis bus, keyed by council id)                                 |
| `abort.ts`      | The stop flag an in-flight run polls                                                               |
| `schema.ts`     | Request validation (zod)                                                                            |
| `http.ts`       | Shared route plumbing (session, access, body, error mapping)                                       |

Routes live in `src/app/api/council/`, the UI in `src/app/dashboard/council/`
and `src/components/council/`.

## The sandbox

Each council gets a **dedicated Open Terminal account**. The council's key is
passed as `X-User-Id`, which Open Terminal maps to its own Linux user whose home
is `chmod 2770` — so a council cannot read the owner's home and the owner cannot
read the sandbox. That is the boundary; it is kernel-enforced, verified against a
live container at design time, and it is why the council does not simply get a
subdirectory of the user's home.

On top of it:

- **Path confinement** (`sandbox.ts`) — every path a file tool is handed is
  normalised and refused when it leaves the sandbox. Defence in depth: the
  account is what actually stops a symlink or a shell from reaching the user's
  files.
- **The mode check** (`ensureCouncilSandbox`) — the container must answer `id -un`
  with the account derived from the key. Without `OPEN_TERMINAL_MULTI_USER=true`
  `X-User-Id` is ignored and everything would run as the owner, so the run refuses
  to start instead.
- **No credentials** — no `GH_TOKEN`, no user MCP servers, no environment beyond
  the container's own.
- **Excluded tools** — `show_file` (reads a file the owner uploaded to a chat)
  and the chat-history tools are removed from a member's session whatever the
  council's tool selection says.

Known limits, honestly:

- Deleting a council removes the account (`sudo userdel -r` through the
  container's own identity) and its home. The `open-terminal` process caches the
  mapping in memory, and pays no attention to a key that is never reused.
- Deleting a council does not stop a run that is in flight — stop it first. The
  run's writes then fail (the rows are gone) and are logged.
- The terminal container is shared with the owner's own workspace by design of
  `OPEN_TERMINAL_MULTI_USER`: `/tmp` and `/proc` are visible to every account in
  it, as they are for any tenant. Home directories are not.
- A council's files are invisible to the owner unless a member pastes content
  into the room. There is no council file browser yet.
- A run is declared abandoned by the sweep when it has not heartbeated for 90s.
  The heartbeat is a timer (15s), so a process whose event loop is blocked for
  longer than that could have a live run marked failed. Nothing in a council
  blocks the loop that long; the run is recoverable (start it again) and the
  record says `timeout`.

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
2. `src/lib/navigation/sidebar-nav.ts` — drop `"council"` from
   `SIDEBAR_NAV_ITEM_IDS` and the definitions map (`defaultHidden` itself is
   generic and can stay).
3. `src/components/layout/sidebar-nav-icons.ts` — drop the `council` icon.
4. `src/app/api/settings/sidebar-nav/route.ts` — drop `unavailableNavIds`/`restrict`
   (or the whole council branch).
5. `src/lib/queue/index.ts` — drop `COUNCIL_SWEEP_*` and `scheduleCouncilSweep`;
   `src/lib/queue/worker.ts` — drop the router branch, the scheduler call and the
   `isCouncilEnabled` import; `src/app/api/council/execute/route.ts` goes with
   step 1.
6. `src/lib/terminal/client.ts` — `executeContainerCommand` is only used by the
   council's account cleanup.
7. Prisma: drop the `// ─── Council ───` models, the `councils` back-relation on
   `User`, and generate a migration.
8. `e2e/modal-scenarios.ts` — drop the council scenarios.

## Tests

`__tests__/lib/council/` covers the pieces that can be wrong quietly: mention
parsing, quorum maths, budget resolution, name drawing, sandbox path confinement
and account derivation, the room tools, the loop's scheduling (mentions, votes,
budgets, stop conditions, round-robin, mid-run steering, failure isolation), turn
transcripts, persistence, and the run lifecycle. `__tests__/api/council/` covers
the message route (handles, busy runs, the access gate). The UI's own behaviour
is covered by the component test beside it and the e2e specs at 375px/320px.
