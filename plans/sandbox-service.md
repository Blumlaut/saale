# Sandbox Service — Plan

Replace the `open-terminal` container with a workspace directory the app owns
and a small in-repo service that runs commands inside it.

---

## What open-terminal does for us today

| Consumer             | File                                        | What it uses                                                   |
| -------------------- | ------------------------------------------- | -------------------------------------------------------------- |
| Chat agent tools     | `src/lib/pi/session.ts`                     | `bash`, `read`, `write`, `edit` over Pi's operation interfaces |
| Council sandbox      | `src/lib/council/sandbox.ts`                | The same four tools, path-confined to the council's account    |
| File browser         | `src/lib/files/terminal-provider.ts`        | list / read / write / upload / mkdir / move / delete           |
| Chat attachments     | `src/lib/file-attachment.ts`                | `uploadFile` into `<home>/uploads`                             |
| Telegram documents   | `src/lib/telegram/files.ts`                 | `uploadFile` into `<home>/telegram_files`                      |
| `show_file` delivery | `src/app/api/chat/workspace-files/route.ts` | `readFileBinary`                                               |
| Infra downloads      | `src/lib/pi/tools/infra-tools.ts`           | The workspace as a local landing directory                     |
| Session cwd          | `src/lib/pi/agent-session.ts`               | The user's container home                                      |

Two properties the app leans on:

- **Command execution.** A real shell with `gh`, `chromium`, `ffmpeg`,
  `imagemagick`, `ripgrep`, `python` and `pip` available, streaming output, exit
  codes, abort and timeout.
- **A tenant boundary.** Every tool call names an identity (`X-User-Id`) and
  runs as that identity's Linux account.

## Why it has to go

### The isolation model is not what the app assumes

The app's council design rests on "the kernel is the boundary". Upstream's
actual model (`open_terminal/utils/user_isolation.py`):

- each identity gets a Linux account with `chmod 2770` on its home,
- the server process is added to **every** new account's group
  (`usermod -aG <user> <server-user>`) so it can read files natively,
- the only path guard is textual: `FsManager.is_path_allowed` rejects
  `/home/<someone-else>/*` and allows everything else.

So the API's file endpoints read and write the whole container as root. A
tenant can read `/proc/1/environ` (the API key), `/etc`, and any app file.
Reported upstream as issue #123 in May, still open with no maintainer reply.
Kernel enforcement holds between two homes and nowhere else.

The app adds path confinement per tool call, which keeps the _model_ inside its
workspace. It does not change what the executor is willing to do.

### The workarounds have their own weight

`src/lib/terminal/client.ts` (672 lines) and `src/lib/terminal/operations.ts`
(295 lines) carry these, each one a bug we cannot fix:

- `sameAccountIdentityKey` (`${key}0`) re-provisioning, because upstream caches
  `X-User-Id → account` in memory and `userdel` never clears it.
- `getent passwd` probing in `accounts.ts` to dodge the same cache.
- `rm -rf` fallback after `userdel -r` refuses while a process of the account
  is alive.
- `gpasswd -d user <account>` plus `groupdel`, because the server account's
  group membership outlives the user.
- An `executeContainerCommand` path for a root-capable identity.
- `statViaParent`: no stat endpoint exists.
- `resolveMimeType` from the extension, because unknown files come back as
  `application/octet-stream`.
- `toEpochMs(seconds * 1000)`.
- A poll loop with `wait: 5` because there is no streaming, a race against the
  abort signal because a poll can sit in that window, `404 → exitCode null`
  because the container drops processes, and a `[output truncated]` marker
  because the log buffer drops earlier output with no way back.
- `writable ?? true` for old builds.

Roughly 200 lines of the client are dead (`replaceFileContent`, `grepSearch`,
`globSearch`, `healthCheck`, `listCommands`).

### Capabilities we cannot get

- Streaming stdout/stderr as it happens.
- Per-tenant CPU, memory, PID and network limits. The sandbox shares the compose
  network, so a command can reach `postgres:5432` and `redis:6379` today.
- A trustworthy stat (size, mode, symlink vs file, millisecond mtime).
- Output offsets that survive truncation.
- Any control over session lifetime: upstream sessions accumulate
  (`OPEN_TERMINAL_MAX_SESSIONS`, issue "Orphaned terminal sessions never get
  removed"), and we create one per chat session.

## Options

### A. Hard fork into this repo

Upstream is MIT, 5.3k lines of Python, one 2.2k-line FastAPI module, its own
Dockerfile and `uv` project. A fork is legally trivial and preserves behaviour.

What it costs:

- A Python toolchain, image build and CI lane in a TypeScript repo.
- Every fix to the isolation layer (server account in every group, `/home`-only
  path guard, in-memory account cache) is a rewrite of the module the fork
  exists to patch. The model is wrong, and the model is the fork.
- Upstream releases roughly monthly with 62 open issues. Every bugfix we want
  and every bugfix they ship is a merge.

Rejected as the primary path. Reasonable as a stopgap if the replacement slips:
pin the image by digest and keep a small vendor patch set.

### B. Per-user volume, filesystem calls routed into it

Solves the file half and nothing about execution. With `bash` gone the chat
agent loses the shell, the council loses its sandbox, and the `gh` / `yt-dlp` /
`chromium` workflows in `TERMINAL_PROMPT` stop existing. This is not a
replacement on its own.

It does match a path that already half exists: `src/lib/files/local-provider.ts`
serves the file browser from `UPLOADS_DIR/<userId>` when the terminal is not
configured, including the `realpath` hardening that a path guard alone misses.

### C. Workspace directory + sandbox service (recommended)

Take B and add the missing half: a service in this repo that runs a tenant's
command in a container which has only that tenant's directory mounted.

## Proposed architecture

```
   ┌────────────────────────── web / worker ───────────────────────────┐
   │  Pi tools (bash) ──HTTP──► sandbox-exec                            │
   │  Pi tools (read/write/edit) ──fs──► /workspaces/<id>               │
   │  file browser / uploads ──────fs──► /workspaces/<id>               │
   │  agent cwd = /workspaces/<id>                                      │
   └────────────────────────────────────────────────────────────────────┘
                    │                            ▲
                    │ docker run/exec            │ SSE
                    ▼                            │
   ┌───────────── sandbox-exec ─────────────┐    │
   │ one container per identity, on demand  │────┘
   │ -v <WS>/<id>:/workspaces/<id>          │
   │ --user 1000 --network saale-sandbox    │
   │ --memory --pids-limit --cap-drop ALL   │
   └────────────────────────────────────────┘
```

### Storage

- `WORKSPACES_DIR` on the host, bind-mounted at `/workspaces` in web and worker
  (`Dockerfile` gains nothing; compose gains one mount). `sandbox-exec` mounts it
  too and is given its **host** path in `WORKSPACES_HOST_DIR`, because a bind
  source in `docker run` is a host path. (The single-volume alternative is
  `--mount type=volume,volume-subpath=<id>`, which needs Docker 26 on the host;
  the host path works on any version.)
- One directory per identity: `user-<userId>` and `council-<sandboxKey>`.
- The **container path and the app path are identical** (`/workspaces/<id>`), so
  no translation layer exists between a bash command and a read tool. A tenant's
  container has exactly one directory at that path; other tenants' directories
  are not present in it at all.
- Ownership: identity directories are created `0777` under a `0777` parent and
  the containers run as a fixed uid, so the web process and a container agree on
  who owns a file without a `chown` after every write. `uploads_data` already
  depends on the same thing, with the app and the terminal container both
  writing to it.
- `Council.sandboxKey` stays as the directory name, so nothing in the schema
  changes. It keeps the unique-per-instance guarantee that already exists and
  drops the Linux-account collision probe.

### Files

`local-provider.ts` already implements list / stat / read / write / mkdir /
rename / remove with `realpath` hardening, and it is tested. Point it at the
workspace instead of `UPLOADS_DIR` and delete `terminal-provider.ts`,
`targets.ts`'s terminal branch, the terminal branch of `workspace-files`, and
the `uploadFile` calls in `file-attachment.ts` and `telegram/files.ts` (both
already write the host copy first). File browsing loses an HTTP hop and gains a
real stat and real MIME types.

### Command execution

`sandbox-exec`, a small Node service built from this repo (`src/sandbox/`,
`Dockerfile.sandbox`):

- `POST /exec` with `{ identity, command, cwd, env, timeoutSeconds }` → SSE of
  `chunk` events, then a terminal `exit` event with the status.
- `DELETE /exec/:id` → kills the exec, which is the abort path.
- `GET /health`.
- Shared key in `Authorization`, identity in `X-Identity`, same shape as today.

Container lifecycle: the service keeps one container per identity, named
`saale-sandbox-<id>` and labelled with the identity. Created on first exec with
the mount, limits and network above; kept warm so background processes survive
between tool calls; stopped after an idle window; swept at startup by label so
restarts do not leak containers.

A command runs as `docker exec`, so `nohup`-style servers persist across calls,
the way they do now.

### Config

| Was                          | Becomes                                     |
| ---------------------------- | ------------------------------------------- |
| `OPEN_TERMINAL_URL`          | `SANDBOX_URL`                               |
| `OPEN_TERMINAL_API_KEY`      | `SANDBOX_API_KEY`                           |
| `OPEN_TERMINAL_MULTI_USER`   | (gone)                                      |
| `OPEN_TERMINAL_PACKAGES`     | `Dockerfile.sandbox`                        |
| `OPEN_TERMINAL_PIP_PACKAGES` | `Dockerfile.sandbox`                        |
| —                            | `WORKSPACES_DIR`, `SANDBOX_CONTAINER_IMAGE` |

With `SANDBOX_URL` unset the app behaves like a deployment without the terminal
today: files work, `bash` is not offered, councils have no workspace.

### Code that goes away

`src/lib/terminal/client.ts`, `src/lib/terminal/operations.ts`,
`src/lib/files/terminal-provider.ts`, `src/lib/council/commands.ts`, the
provisioning and teardown half of `src/lib/council/sandbox.ts`, and the
account/collision half of `src/lib/council/accounts.ts`
(`accounts.ts` keeps `deriveSandboxKey` and `sandboxIdentity`).

## Migrating the live data

Live state is 5 users, 0 councils, and three directories under
`/home` (`u7rv9dfnn`, `vcxyvmjy`, `user`) holding small `uploads/` folders.
So the migration is a directory copy, not a translation:

1. `scripts/migrate-workspaces.mjs`: for each `user` row, `docker cp` from
   `/home/<derived-account>/` into `<WORKSPACES_DIR>/user-<id>/`, skipping
   `.bash*`, `.profile`, `.cache`, `.local/state`.
2. Same for councils from `Council.sandboxKey` (none today).
3. Anything left in `/home` after mapping goes to `<WORKSPACES_DIR>/_orphaned/`
   and is reported, never deleted.
4. Verify file counts and byte totals per directory before and after, then
   start the app.

The old volume is kept for one release after cutover.

## Phases

| #   | Work                                                                                                                                             | Size       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- |
| 1   | Workspace directories, `local-provider` retargeted, uploads/`show_file`/browser/council files on fs, migration script                            | 1–2 days   |
| 2   | `sandbox-exec` + `Dockerfile.sandbox` + `src/lib/sandbox/operations.ts`, wire `session.ts` and `council/sandbox.ts`, delete the terminal modules | 2–3 days   |
| 3   | Council lifecycle simplification (create = `mkdir`, delete = `rm -rf` + container removal), drop the `ensureCouncilSandbox` probe                | half a day |
| 4   | Compose, `.env.example`, README, docs, tests                                                                                                     | half a day |

Phase 1 is worth landing alone: it is the fix for the isolation bug and it makes
the file browser faster while command execution stays on open-terminal.

## Risks

- **We own a sandbox image.** `Dockerfile.sandbox` carries the package list that
  `OPEN_TERMINAL_PACKAGES` carries today (chromium, ffmpeg, imagemagick, build
  tooling). Build time and size land on us; start from `debian:trixie-slim` and
  keep it to one stage.
- **Docker socket.** Only `sandbox-exec` mounts it, which is the same
  privilege profile the root-capable terminal container has today, with a
  stronger tenant boundary.
- **Cold starts** are removed by the warm-container design; if it is dropped for
  simplicity, expect ~1s on the first command of a conversation.
- **Sandbox network.** A dedicated network means a command can no longer reach
  `postgres` or `redis` (a win). Anything that legitimately needed `searxng` or
  `web` from the shell must be added to it explicitly.
- **Leftover Linux accounts.** Teardown stops creating accounts at all, so
  `userdel` / `groupdel` bugs stop mattering; the existing ones are removed once
  by the migration.
