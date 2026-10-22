# Sandbox Service — Plan

Replace the `open-terminal` container with a workspace directory the app owns and
a small in-repo service that runs commands in a container holding one workspace.

Isolation target: **a user's code can never read another user's files**, and
neither can a council member read its owner's files.

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

## Why it has to go

### Its isolation is not the isolation the app assumes

The council design rests on "the kernel is the boundary". Upstream's actual
model (`open_terminal/utils/user_isolation.py`):

- each identity gets a Linux account with `chmod 2770` on its home,
- the server process is added to **every** new account's group
  (`usermod -aG <user> <server-user>`) so it can read files natively,
- the only path guard is textual: `FsManager.is_path_allowed` rejects
  `/home/<someone-else>/*` and allows everything else.

So the API's file endpoints read and write the container as root. Any tenant can
read `/proc/1/environ` (the API key), `/etc`, and every app file. Reported
upstream as issue #123 in May, still open with no maintainer reply. Kernel
enforcement holds between two homes and nowhere else.

### The workarounds have their own weight

`src/lib/terminal/client.ts` (672 lines) and `src/lib/terminal/operations.ts`
(295 lines) carry these, each one a bug we cannot fix:

- `sameAccountIdentityKey` (`${key}0`) re-provisioning, because upstream caches
  `X-User-Id → account` in memory and `userdel` never clears it.
- `getent passwd` probing to dodge the same cache.
- `rm -rf` fallback after `userdel -r` refuses while a process of the account is
  alive.
- `gpasswd -d user <account>` plus `groupdel`, because the server account's
  group membership outlives the user.
- A root-capable `executeContainerCommand` path, plus `statViaParent` because
  there is no stat endpoint, `resolveMimeType` from the extension because
  unknown files come back as `application/octet-stream`, and
  `toEpochMs(seconds * 1000)`.
- A poll loop with `wait: 5` because there is no streaming, a race against the
  abort signal because a poll sits in that window, `404 → exitCode null` because
  the container drops processes, and a `[output truncated]` marker because the
  log buffer drops earlier output with no way back.

About 200 lines of the client are dead (`replaceFileContent`, `grepSearch`,
`globSearch`, `healthCheck`, `listCommands`).

### Capabilities we cannot get

- Streaming stdout/stderr as it happens.
- Per-tenant CPU, memory, PID and network limits. The sandbox shares the compose
  network, so a command reaches `postgres:5432` and `redis:6379` today.
- A trustworthy stat, and output offsets that survive truncation.
- Session lifetime control: upstream sessions accumulate
  (`OPEN_TERMINAL_MAX_SESSIONS`), and we create one per chat session.

## Why not fork it

Upstream is MIT, 5.3k lines of Python, one 2.2k-line FastAPI module, its own
Dockerfile and `uv` project. A fork is legally trivial and preserves behaviour,
but:

- It puts a Python toolchain, image build and CI lane into a TypeScript repo.
- The fixes that matter (the server account in every group, the `/home`-only
  path guard, the in-memory account cache) are a rewrite of the isolation
  layer, which is the module the fork exists to patch.
- Upstream ships roughly monthly with 62 open issues, so every bugfix on either
  side is a merge.

Reasonable only as a stopgap: pin the image by digest and keep a small vendor
patch set.

## The isolation model

Three locks, each enforced by the kernel or by a structure the caller cannot
express. Verified on this host with Docker 29 (see "Verified behaviour").

**Lock 1: a tenant's container holds one directory.**
The container mounts `<workspaces>/<id>` at `/workspaces/<id>`. No other
workspace path exists inside it, so `open("../other-user/x")` is `ENOENT`. The
workspaces root is never mounted into a sandbox container.

**Lock 2: per-identity uid, 0700 directory.**
Every workspace gets a uid and gid of its own, allocated from a Postgres
sequence and unique in the database. The directory is `0700 <uid>:<uid>`, and
the container runs as `--user <uid>:<uid>`. If a mount is ever wrong, the kernel
still refuses: uid B reading a `0700` directory owned by uid A gets `EACCES`.

**Lock 3: the caller cannot name a workspace by path.**
Every sandbox request carries an `identity` that the app derives from the
session (`user:<id>`, or a council's `sandboxKey` behind `requireCouncilAccess`).
The sidecar turns the identity into a directory, a uid and a mount. There is no
request field holding a workspace root, a host path, or a directory name, so no
request can ask for another tenant's tree. The sidecar additionally refuses a
workspace whose directory owner is not the uid in the request, which catches a
caller that gets the mapping wrong.

The app itself is trusted: it holds every user's rows in Postgres, so it is not
part of the threat model. A user reading another user's files through the app
needs an authorization bug, the same class as a missing `userId` in a query.

## Architecture

```
   ┌────────────────────────── web / worker ───────────────────────────┐
   │  Pi file tools ──fs──► /workspaces/<id>   (trusted, root)          │
   │  file browser / uploads / show_file ──fs──► /workspaces/<id>       │
   │  Pi bash tool ──HTTP──► sandbox-exec ──► container of one identity │
   │  agent cwd = /workspaces/<id>                                      │
   └────────────────────────────────────────────────────────────────────┘
                                  │ docker (socket, sandbox-exec only)
                                  ▼
        ┌──────── sandbox container for identity X ────────┐
        │ --user <uidX>:<gidX>                             │
        │ -v <host>/workspaces/<X>:/workspaces/<X>         │
        │ --network saale-sandbox --cap-drop ALL           │
        │ no socket, no app network, no DB, no Redis       │
        └──────────────────────────────────────────────────┘
```

### Storage

- `WORKSPACES_DIR` on the host, bind-mounted at `/workspaces` in web and worker.
  `sandbox-exec` mounts it too and gets the **host** path in
  `WORKSPACES_HOST_DIR`, because a bind source in `docker run` is a host path.
  (The single-volume alternative is `--mount type=volume,volume-subpath=<id>`,
  which needs Docker 26 on the host; a host path works on any version.)
- One directory per identity: `user-<userId>`, `council-<sandboxKey>`. The app
  path and the container path are the same string, so a path the model reads
  with `read` resolves identically when it `cat`s it in bash.
- Files are `0700` and owned by the identity's uid. The app runs as root (as it
  does today) and `chown`s anything it writes into a workspace to the identity,
  so a file the browser uploads is owned by the tenant and a file the tenant
  writes is readable by the browser.
- A `Workspace` row is the registry: identity (primary key), uid, gid, directory
  name, `createdAt`, `lastUsedAt`. Uid allocation comes from a sequence with a
  unique index, never from a hash, because a hash collision between two
  identities would be a silent grant of access.

### Command execution

`sandbox-exec`, a small Node service built from this repo (`src/sandbox/`):

- `POST /exec` with `{ identity, command, cwd, env, timeoutSeconds }` → SSE of
  `chunk` events, then an `exit` event with the status.
- `DELETE /exec/:id` → kills it. That is the abort path.
- `GET /health`.
- Shared key in `Authorization`, identity in `X-Identity`.

Container spec, built only from the identity's `Workspace` row:

| Flag                                                         | Why                                                                                                                  |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `--user <uid>:<gid>`                                         | Lock 2. The sidecar refuses to create a container without it.                                                        |
| `--mount type=bind,source=<WS>/<id>,target=/workspaces/<id>` | Lock 1. The only mount a sandbox container ever has.                                                                 |
| `--workdir /workspaces/<id>`, `--env HOME=/workspaces/<id>`  | A predictable cwd and home.                                                                                          |
| `--mount …,target=/etc/passwd`                               | A generated passwd stub, so `whoami`, `id -un` and `$HOME` work for a uid with no host account.                      |
| `--network saale-sandbox`                                    | Keeps commands off `postgres`, `redis`, `web` and the sidecar.                                                       |
| `--cap-drop ALL --security-opt no-new-privileges`            | No capability to escalate with.                                                                                      |
| `--init`                                                     | Reaps zombies from backgrounded processes.                                                                           |
| `--memory`, `--pids-limit`, `--cpus`                         | Per-tenant ceilings, configurable.                                                                                   |
| `--read-only` + `--tmpfs /tmp`                               | The workspace is the only writable path. Optional; needs the image to keep everything else out of `/usr` and `/etc`. |

Lifecycle: one container per identity, named `saale-sandbox-<id>`, labelled with
the identity. Created on first use, kept warm so background processes survive
between tool calls (as `nohup` does today), stopped after an idle window, swept
by label at startup so a restart does not leak containers. Council deletion
removes the directory and the container; it no longer runs `userdel`,
`gpasswd` or `groupdel`.

### Files

`src/lib/files/local-provider.ts` already implements list / stat / read / write /
mkdir / rename / remove with `realpath` hardening and tests. Point it at the
workspace root and delete `terminal-provider.ts`, the terminal branch of
`targets.ts`, the terminal branch of `workspace-files`, and the `uploadFile`
calls in `file-attachment.ts` and `telegram/files.ts` (both already write the
host copy first). The seven `/api/files/*` routes, the zip builder and
`readWorkspaceFile` do not change: they speak the `FileProvider` interface.

File browsing then costs no network hop and gains a real stat, real MIME types
and millisecond mtimes.

### Config

| Was                          | Becomes                                                                                |
| ---------------------------- | -------------------------------------------------------------------------------------- |
| `OPEN_TERMINAL_URL`          | `SANDBOX_URL`                                                                          |
| `OPEN_TERMINAL_API_KEY`      | `SANDBOX_API_KEY`                                                                      |
| `OPEN_TERMINAL_MULTI_USER`   | (gone)                                                                                 |
| `OPEN_TERMINAL_PACKAGES`     | `Dockerfile.sandbox`                                                                   |
| `OPEN_TERMINAL_PIP_PACKAGES` | `Dockerfile.sandbox`                                                                   |
| —                            | `WORKSPACES_DIR`, `WORKSPACES_HOST_DIR`, `SANDBOX_CONTAINER_IMAGE`, `SANDBOX_UID_BASE` |

With `SANDBOX_URL` unset the app behaves like a deployment without the terminal
today: files work, `bash` is not offered, councils have no workspace.

### Code that goes away

`src/lib/terminal/client.ts`, `src/lib/terminal/operations.ts`,
`src/lib/files/terminal-provider.ts`, `src/lib/council/commands.ts`, the
provisioning and teardown half of `src/lib/council/sandbox.ts`, and the
account/collision half of `src/lib/council/accounts.ts` (`accounts.ts` keeps
`deriveSandboxKey` and `sandboxIdentity`).

## Verified behaviour

Checked against this host's Docker before writing the spec:

- uid B reading a `0700` directory owned by uid A, **with A's directory mounted
  in B's container**: `Permission denied`.
- the same mount in a container running as root: readable. So `--user` is
  mandatory, and `sandbox-exec` refuses to create a container without one.
- a container running as a uid with no `/etc/passwd` entry gets `HOME=/` and
  `whoami: unknown uid`. A bind-mounted stub with
  `agent:x:<uid>:<gid>::/workspaces/<id>:/bin/sh` fixes both.
- **uid numbers must be representable by the host.** This machine runs in a user
  namespace that only maps 0..65535, so `chown 200123` fails with `EINVAL` and
  the container does not start at all. Hence `SANDBOX_UID_BASE` (default 20000)
  plus a startup probe: the sidecar chowns a probe file to a candidate uid and
  refuses to start if that fails, naming the range to change.
- rootless Docker maps every container into one subuid window, so distinct uids
  stop being distinct on disk. Lock 1 still holds; Lock 2 does not. Run this
  stack on rootful Docker (as compose does today) and say so in the README.

## Tests that prove it

- `__tests__/lib/sandbox/spec.test.ts`: the container spec from a `Workspace`
  row has exactly one mount, always a `--user`, and the mount source is that
  identity's directory. Runs in CI.
- `__tests__/integration/sandbox-isolation.test.ts`: two workspaces, two uids.
  Asserts the tenant cannot read, write or list the other, cannot reach the app,
  the DB or the sidecar, and that the sidecar refuses a container without a uid
  and refuses a directory whose owner is not the requested uid. Opt-in
  (`SANDBOX_ISOLATION=1`) because CI has no Docker.
- `__tests__/lib/files/*` stays as is, running against the retargeted
  `local-provider`.
- An e2e browse of a workspace that does not exist yet (a council created a
  minute ago), which is the case that used to need `ensureCouncilSandbox`.

## Migrating the live data

Live state is 5 users, 0 councils, and three directories under `/home`
(`u7rv9dfnn`, `vcxyvmjy`, `user`) holding small `uploads/` folders.

1. `scripts/migrate-workspaces.mjs`: for each `user` row, `docker cp` from
   `/home/<derived-account>/` into `<WORKSPACES_DIR>/user-<id>/`, skipping
   `.bash*`, `.profile`, `.cache`, `.local/state`.
2. Same for councils from `Council.sandboxKey` (none today).
3. Allocate each workspace's uid, `chown` the directory and everything in it.
4. Anything left in `/home` after mapping goes to `<WORKSPACES_DIR>/_orphaned/`
   and is reported, never deleted.
5. Verify file counts and byte totals per directory before and after, then start
   the app. The old volume is kept for one release after cutover.

## Phases

| #   | Work                                                                                                                                                            | Size       |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| 1   | `Workspace` table + uid allocation, workspace directories, `local-provider` retargeted, uploads / `show_file` / browser / council files on fs, migration script | 1–2 days   |
| 2   | `sandbox-exec` + `Dockerfile.sandbox` + `src/lib/sandbox/operations.ts`, wire `session.ts` and `council/sandbox.ts`, delete the terminal modules                | 2–3 days   |
| 3   | Council lifecycle simplification (create = `mkdir`, delete = `rm -rf` + container removal)                                                                      | half a day |
| 4   | Compose, `.env.example`, README, docs, isolation tests                                                                                                          | half a day |

Phase 1 lands alone: it is the isolation fix for files and it makes the browser
faster while command execution stays on open-terminal. Phase 3 is the one that
retires the `userdel` / `gpasswd` bugs for good.

## Risks

- **We own a sandbox image.** `Dockerfile.sandbox` carries the package list that
  `OPEN_TERMINAL_PACKAGES` carries today (chromium, ffmpeg, imagemagick, build
  tooling, `gh`, `yt-dlp`). Start from `debian:trixie-slim`, one stage.
- **The Docker socket** lives in `sandbox-exec` only, the same privilege profile
  the root-capable terminal container has today, with a real tenant boundary.
- **Passwd stub upkeep**: regenerated per container from the image's own
  `/etc/passwd` plus the identity line, so an image change cannot drift.
- **The sandbox network** is closed to `postgres`, `redis`, `web` and the
  sidecar. Anything that legitimately needs `searxng` from the shell gets added
  explicitly. Bash keeps internet egress, which `pip`, `npm` and `yt-dlp` need.
- **Cold start** is removed by keeping the container warm. If that is dropped,
  the first command of a conversation pays ~1s.
