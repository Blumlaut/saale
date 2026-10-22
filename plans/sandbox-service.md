# Sandbox Service — Plan

Replace the `open-terminal` container with a workspaces volume the app owns and a
small in-repo service that runs each identity's commands in a container holding
one directory of that volume.

Isolation target: **a user's code can never read another user's files**, and a
council member can never read its owner's files. No Linux accounts are ever
created, on the host or in a container.

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
  the container drops processes, and a `[truncated]` marker because the log
  buffer drops earlier output with no way back.

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
but it puts a Python toolchain, image build and CI lane into a TypeScript repo,
and the fixes that matter (the server account in every group, the `/home`-only
path guard, the in-memory account cache) are a rewrite of the isolation layer,
which is the module the fork exists to patch. Upstream ships roughly monthly with
62 open issues, so every bugfix on either side is a merge.

Reasonable only as a stopgap: pin the image by digest and keep a small vendor
patch set.

## The isolation model

### No Linux accounts, anywhere

The workspace holds data owned by a **single numeric uid**, the same one for every
tenant. A numeric file owner is not an account: no `/etc/passwd` entry, no
login, no home, no shell. Nothing is created on the host, nothing is created with
`useradd`, and teardown is `rm -rf` of a directory instead of `userdel` plus
`gpasswd` plus `groupdel`.

`SANDBOX_UID` (default `1000`) is baked into the sandbox image as a real account
(`agent`, via `ARG SANDBOX_UID`) so `whoami`, `id -un` and `$HOME` behave inside
the container. Raise it on a host where uid 1000 is a login account. The only
thing the number affects on the host is the owner recorded on files under
`/var/lib/docker/volumes`, which is `0710 root:docker`.

A per-identity uid would add a second lock (a `0700` directory refuses uid B even
if it is mounted). It costs nothing in accounts — only a number — but it needs a
uid registry, a representability probe, and a passwd stub for uids with no entry.
Given Lock 1 below, it buys little; it is a one-line change to the container spec
if it is ever wanted.

### Lock 1: a tenant's container contains one directory

Every identity gets its own directory in the `saale_workspaces` volume. Its
container mounts **that directory alone**:

```
--mount type=volume,source=saale_workspaces,target=/workspaces/<id>,volume-subpath=<id>
```

Inside the container, `/workspaces` has exactly one entry: `<id>`. Another
tenant's directory is not present at any path, so `../../other` is `ENOENT`.
The volume root is never mounted into a sandbox container.

Verified on this host (Docker 29.9.1): a container mounting subpath `userB`
lists only `userB`, and `/workspaces/userA/f` is `No such file or directory`.

### Lock 2: the caller cannot name a workspace

Every sandbox request carries an `identity` the app derives from the session
(`user:<id>`, or a council's `sandboxKey` behind `requireCouncilAccess`). The
sidecar turns the identity into a directory and a subpath. No request field holds
a workspace root, a host path or a directory name, so no request can ask for
another tenant's tree.

Path arguments inside a workspace are resolved and confined by the app
(`resolveWithinRoot`) before they reach the sidecar, and the sidecar refuses
anything that does not resolve inside `/workspaces/<id>` after `realpath`.

### Lock 3: the container is checked against the spec

At container creation the sidecar asserts, from inside the container, that
`/proc/self/mountinfo` has exactly one `/workspaces/` mount and that it is the
expected subpath. A mismatch destroys the container and refuses the request.
A unit test pins the generated spec (one mount, always a `--user`).

### What the app can still do

The app mounts the whole volume, so it reads and writes every workspace: the file
browser, uploads, `show_file`, the zip builder. That is deliberate, because the
app already holds every user's database rows, so it is not part of the threat
model. A user reading another user's files through the app needs an
authorization bug, the same class as a missing `userId` in a query.

The alternative — a volume per identity, with the app reaching files only through
`docker exec` — is equivalent against the app (it can always ask the sidecar for
any identity) and costs a network hop plus a file helper baked into the image.
Not worth it.

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
        │ --user <SANDBOX_UID>:<SANDBOX_GID>               │
        │ one mount: volume-subpath X → /workspaces/X      │
        │ --network saale-sandbox --cap-drop ALL           │
        │ no socket, no app network, no DB, no Redis       │
        └──────────────────────────────────────────────────┘
```

### Storage

- One named volume, `saale_workspaces`, created by compose on first `up` and
  reused across deploys.
- One directory per identity: `user-<userId>`, `council-<sandboxKey>`, created on
  demand by the app (`mkdir`, `chown`, mode `0770` to match `SANDBOX_UID`).
- The app path and the container path are the same string, so a path the model
  reads with `read` resolves identically when it `cat`s it in bash.
- Anything the app writes into a workspace is `chown`ed to `SANDBOX_UID`, so the
  tenant can edit a file it uploaded through the browser.
- `Council.sandboxKey` already names the directory, and user ids name the other
  one, so **no schema change and no migration**.

### Command execution

`sandbox-exec`, a small Node service built from this repo (`src/sandbox/`):

- `POST /exec` with `{ identity, command, cwd, env, timeoutSeconds }` → SSE of
  `chunk` events, then an `exit` event with the status.
- `DELETE /exec/:id` → kills it. That is the abort path.
- `GET /health`.
- Shared key in `Authorization`, identity in `X-Identity`.

Container spec, built only from the identity string:

| Flag                                                                                      | Why                                                                                                                  |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `--mount type=volume,source=saale_workspaces,target=/workspaces/<id>,volume-subpath=<id>` | Lock 1. The only mount a sandbox container ever has.                                                                 |
| `--user <SANDBOX_UID>:<SANDBOX_GID>`                                                      | Files are tenant-owned, and root inside a container would ignore the volume's modes.                                 |
| `--workdir /workspaces/<id>`                                                              | A predictable cwd, and it is what the app resolves tool paths against.                                               |
| `--network saale-sandbox`                                                                 | Keeps commands off `postgres`, `redis`, `web` and the sidecar. Internet egress stays, for `pip`, `npm`, `yt-dlp`.    |
| `--cap-drop ALL --security-opt no-new-privileges`                                         | No capability to escalate with.                                                                                      |
| `--init`                                                                                  | Reaps zombies from backgrounded processes.                                                                           |
| `--memory`, `--pids-limit`, `--cpus`                                                      | Per-tenant ceilings, configurable.                                                                                   |
| `--read-only` + `--tmpfs /tmp`                                                            | The workspace is the only writable path. Optional; needs the image to keep everything else out of `/usr` and `/etc`. |

Lifecycle: one container per identity, named `saale-sandbox-<id>`, labelled with
the identity. Created on first use, kept warm so background processes survive
between tool calls (as `nohup` does today), stopped after an idle window, swept
by label at startup so a restart does not leak containers. Council deletion
removes the directory and the container.

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

| Was                          | Becomes                                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------------------------ |
| `OPEN_TERMINAL_URL`          | `SANDBOX_URL`                                                                                    |
| `OPEN_TERMINAL_API_KEY`      | `SANDBOX_API_KEY`                                                                                |
| `OPEN_TERMINAL_MULTI_USER`   | (gone)                                                                                           |
| `OPEN_TERMINAL_PACKAGES`     | `Dockerfile.sandbox`                                                                             |
| `OPEN_TERMINAL_PIP_PACKAGES` | `Dockerfile.sandbox`                                                                             |
| —                            | `WORKSPACES_DIR`, `WORKSPACES_HOST_DIR`, `SANDBOX_CONTAINER_IMAGE`, `SANDBOX_UID`, `SANDBOX_GID` |

With `SANDBOX_URL` unset the app behaves like a deployment without the terminal
today: files work, `bash` is not offered, councils have no workspace.

### Code that goes away

`src/lib/terminal/client.ts`, `src/lib/terminal/operations.ts`,
`src/lib/files/terminal-provider.ts`, `src/lib/council/commands.ts`, the
provisioning and teardown half of `src/lib/council/sandbox.ts`, and the
account/collision half of `src/lib/council/accounts.ts` (`accounts.ts` keeps
`deriveSandboxKey` and `sandboxIdentity`, minus the Linux-account mapping).

## Verified behaviour

Checked against this host before writing the spec:

- a container mounting volume subpath `userB` sees only `userB`; reading
  `/workspaces/userA/f` fails with `ENOENT`.
- `/proc/self/mountinfo` inside such a container has exactly one `/workspaces/`
  entry, and it names the subpath, so Lock 3 has something concrete to assert.
- a directory created by the app (root) and `chown`ed to `1000:1000` is writable
  by the container running as uid 1000, and files the tenant writes are readable
  by the app.
- `volume-subpath` needs Docker 26 or newer (this host: 29.9.1, Compose v5.6.0).
  On an older host, bind-mount `<WORKSPACES_DIR>/<id>` from the host instead; the
  rest of the design is identical.

## Tests that prove it

- `__tests__/lib/sandbox/spec.test.ts`: the container spec from an identity has
  exactly one mount, a `--user`, and a subpath equal to that identity. Runs in
  CI.
- `__tests__/integration/sandbox-isolation.test.ts`: two identities, two
  containers. Asserts the cross-read, cross-write and cross-list all fail, that
  the mount list inside a container has one entry, and that a command cannot
  reach `postgres`, `redis` or the sidecar. Opt-in (`SANDBOX_ISOLATION=1`)
  because CI has no Docker.
- `__tests__/lib/files/*` stays as is, running against the retargeted
  `local-provider`.
- An e2e browse of a workspace that does not exist yet (a council created a
  minute ago), which is the case that used to need `ensureCouncilSandbox`.

## Migrating the live data

Live state is 5 users, 0 councils, and three directories under `/home`
(`u7rv9dfnn`, `vcxyvmjy`, `user`) holding small `uploads/` folders.

1. `scripts/migrate-workspaces.mjs`: for each `user` row, copy
   `/home/<derived-account>/` to `<volume>/user-<id>/`, skipping `.bash*`,
   `.profile`, `.cache`, `.local/state`. Same for councils from
   `Council.sandboxKey` (none today).
2. `chown -R <SANDBOX_UID>` each new directory.
3. Anything left in `/home` after mapping goes to `<volume>/_orphaned/` and is
   reported, never deleted.
4. Verify file counts and byte totals per directory before and after, then start
   the app. The old volume is kept for one release after cutover.

## Phases

| #   | Work                                                                                                                                | Size       |
| --- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| 1   | `sandbox-exec` + `Dockerfile.sandbox` (SSE exec, container lifecycle, spec) and `src/lib/sandbox/operations.ts`; wire `session.ts`  | 2–3 days   |
| 2   | Workspace directories, `local-provider` retargeted, uploads / `show_file` / browser / council files on the volume, migration script | 1–2 days   |
| 3   | Council lifecycle simplification (create = `mkdir`, delete = `rm -rf` + container removal)                                          | half a day |
| 4   | Compose, `.env.example`, README, docs, isolation tests                                                                              | half a day |

Phase 2 is the file-side switch and works with either backend; landing it first
is fine and makes the browser faster immediately.

## Risks

- **We own a sandbox image.** `Dockerfile.sandbox` carries the package list that
  `OPEN_TERMINAL_PACKAGES` carries today (chromium, ffmpeg, imagemagick, build
  tooling, `gh`, `yt-dlp`) and an `agent` account built from `ARG SANDBOX_UID`.
  Start from `debian:trixie-slim`, one stage.
- **The Docker socket** lives in `sandbox-exec` only, the same privilege profile
  the root-capable terminal container has today, with a real tenant boundary.
- **One volume, one uid.** If the volume root were ever mounted into a sandbox
  container, every workspace would be readable (nothing distinguishes them but
  the path). Lock 3 exists to catch exactly that, and the spec test pins it.
- **The sandbox network** is closed to `postgres`, `redis`, `web` and the
  sidecar. Anything that legitimately needs `searxng` from the shell gets added
  explicitly.
- **Cold start** is removed by keeping the container warm. If that is dropped,
  the first command of a conversation pays ~1s.
