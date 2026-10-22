# Sandbox Service — Implementation Plan

Ship a workspaces volume the app owns, and a small service in this repo that runs
each identity's commands in a container holding one directory of that volume.
`open-terminal` leaves the stack.

---

## Why we drop open-terminal

- Its multi-user isolation is a textual check. `FsManager.is_path_allowed` rejects
  `/home/<someone-else>/*` and allows every other path, and the API server is a
  member of every provisioned account's group (a `usermod -aG` per account), so
  its file endpoints read and write the whole container as root. Any tenant can
  read `/proc/1/environ`, `/etc`, and the app's files. Upstream issue #123,
  open since May, no maintainer reply.
- The app's council design depends on kernel-enforced separation between two
  identities. Upstream enforces that between two home directories and nowhere
  else.
- We carry ten workarounds for upstream behaviour we cannot change: an in-memory
  `X-User-Id → account` cache that survives `userdel` (hence the `${key}0`
  re-provision trick), `getent passwd` collision probing, a `rm -rf` fallback when
  `userdel -r` refuses, `gpasswd -d` / `groupdel` on teardown, `executeContainer`
  commands run as root, stat through the parent listing, MIME type from the file
  extension, `seconds → milliseconds` conversion, a `wait: 5` poll loop with an
  abort race and `404 → null exit code`, and a truncation marker for output the
  log buffer dropped. `src/lib/terminal/` is 967 lines plus tests, and about 200
  lines of it are dead code.
- Command output arrives through polling, so streaming, exit codes and aborts all
  have to be simulated. Sessions accumulate, and we create one per chat session.
  A tenant's container shares the compose network with Postgres and Redis.
- Upstream is 5.3k lines of Python with its own `uv` project, so a fork puts a
  second toolchain, image build and CI lane into this repo, and the isolation
  fixes are a rewrite of the module the fork would exist for.

## What we build

One volume, one service, one workspace path convention.

```
web / worker                          sandbox-exec                    sandbox image
├── files: /workspaces/<id>  ◄──fs──  (mounted volume)                debian + tooling
├── bash tool ────────────HTTP─────►  POST /exec  ──docker exec──►    container per
└── session cwd = /workspaces/<id>    DELETE /exec/:id               identity, one
                                                                     subpath mount
```

- **`saale_workspaces`**, one named volume. `<volume>/user-<userId>/` and
  `<volume>/council-<sandboxKey>/`. Mounted at `/workspaces` in web and worker,
  so the app path and the container path are the same string.
- **`sandbox-exec`**, a Node service built from this repo. It holds the Docker
  socket and owns every container.
- **`saale-sandbox`**, the tenant image: the package list `OPEN_TERMINAL_PACKAGES`
  carries today, plus an `agent` account at `SANDBOX_UID`.

## Implementation steps

Each step is a commit that leaves `npm run check` green.

### Step 1 — identity and container spec

New:

- `src/lib/sandbox/identity.ts` — `parseIdentity(raw)`, `userIdentity(userId)`,
  `councilIdentity(sandboxKey)`. An identity is `user-<id>` or
  `council-<key>`, matching `/^(user|council)-[A-Za-z0-9_-]{1,64}$/`. It is the
  only handle a caller passes.
- `src/lib/sandbox/config.ts` — `SANDBOX_VOLUME`, `SANDBOX_CONTAINER_IMAGE`,
  `SANDBOX_NETWORK`, `SANDBOX_UID`, `SANDBOX_GID`, `SANDBOX_MEMORY`,
  `SANDBOX_PIDS`, `SANDBOX_CPUS`, `SANDBOX_IDLE_MINUTES`, `SANDBOX_URL`,
  `SANDBOX_API_KEY`.
- `src/lib/sandbox/spec.ts` — `containerSpec(identity, config)` returning the
  `dockerode` create options. Pure, so the isolation rules are testable.

Tests: `__tests__/lib/sandbox/spec.test.ts` asserts one mount per identity, its
`VolumeOptions.Subpath` equal to the identity, a `User` on both the container and
every exec, the sandbox network, `CapDrop: ["ALL"]`, and that a malformed
identity throws.

### Step 2 — the `sandbox-exec` service

New:

- `src/sandbox/server.ts` — `node:http`, no framework. `GET /health`,
  `POST /exec`, `DELETE /exec/:id`. `Authorization: Bearer <SANDBOX_API_KEY>`,
  identity in `X-Identity`.
- `src/sandbox/containers.ts` — `dockerode` wrapper: `ensure(identity)`,
  `exec(identity, { command, cwd, env, timeoutSeconds })`, `kill(execId)`,
  `remove(identity)`, `sweep()`, `reapIdle()`.
- `src/sandbox/mount-check.ts` — after creating a container, one exec runs
  `cat /proc/self/mountinfo`; the service requires exactly one `/workspaces/`
  entry and that it names the identity's subpath. A mismatch removes the
  container and fails the request.
- `src/sandbox/registry.ts` — in-memory map of `execId → { identity, pgid }`.

Command execution:

- `ensure(identity)` inspects `saale-sandbox-<id>` and creates or starts it.
  Creation sets everything in the spec table below, plus `HOME` and `--init`.
- A command runs as `Container.exec({ Cmd, User, WorkingDir, Env, AttachStdout,
AttachStderr })`, started with `{ hijack: true, stdin: true }`. The stream is
  demultiplexed with `docker.modem.demuxStream` into the two SSE lanes, and
  `exec.inspect()` supplies the exit code once it ends.
- `POST /exec` answers `text/event-stream`:
  `event: started` (the exec id), then `event: chunk` with
  `{ stream: "stdout"|"stderr", data: <base64> }`, then
  `event: exit` with `{ exitCode, timedOut, durationMs }`.
- Abort: the command runs under `setsid`, and its process group id is written to
  `/tmp/.saale-<execId>.pgid` inside the container. `DELETE /exec/:id` runs a
  second exec that signals the group, so a pipeline dies whole. The server also
  signals the group when `timeoutSeconds` expires and reports `timedOut`.
- `reapIdle()` stops containers idle past `SANDBOX_IDLE_MINUTES`; `sweep()` runs
  at boot and stops labelled containers left by a previous process.

Wiring:

- `package.json` — `dockerode` + `@types/dockerode`, and
  `build:sandbox: esbuild src/sandbox/server.ts --bundle --platform=node
--packages=external --outfile=dist/sandbox.mjs --format=esm --target=node26`.
- `Dockerfile` — the `production-worker` target also copies `dist/sandbox.mjs`.
- `Dockerfile.sandbox` — `debian:trixie-slim`, `ARG SANDBOX_UID=1000`,
  `useradd -u $SANDBOX_UID -m -d /workspaces agent`, the current package list
  (chromium and its libraries, ffmpeg, imagemagick, build-essential,
  libssl/libffi/python dev headers, jq, curl, wget, ripgrep, fd-find, ag, git,
  `gh`), `pip install --break-system-packages yt-dlp`, `WORKDIR /workspaces`.
- `docker-compose.yml` — service `sandbox-exec` (app network, socket mounted,
  `command: node sandbox.mjs`), service build for `saale-sandbox`, volume
  `saale_workspaces` mounted at `/workspaces` in web and worker, network
  `saale-sandbox`.

Tests: `__tests__/lib/sandbox/containers.test.ts` with an injected fake docker
handle (create options, reuse of a stopped container, demuxed chunks, exit code,
group kill on abort, sweep by label).

### Step 3 — client and Pi operations

New:

- `src/lib/sandbox/client.ts` — `isConfigured()`, `exec(identity, options)` as an
  async iterable of events, `kill(execId)`, `remove(identity)`, `health()`.
- `src/lib/sandbox/operations.ts` — the four Pi operation objects:
  - `bash.exec` forwards `onData`, `signal` and `timeout` to `client.exec`, and
    maps a signal to `kill`;
  - `read`, `write`, `edit` use `node:fs` against `identityPath(identity)`, with
    `resolveWithinRoot` on every argument.

Changed:

- `src/lib/pi/session.ts` — `createTerminalScopedTools` becomes
  `createSandboxScopedTools`, keeping the `GH_TOKEN` injection (as exec env).
- `src/lib/pi/agent-session.ts` — the session cwd is the workspace path.
- `src/lib/pi/tool-registry.ts` — `isConfigured` from the new client.

Tests: `__tests__/lib/sandbox/operations.test.ts` (streamed chunks reach
`onData`, exit code and timeout surface as Pi expects, abort kills, reads and
writes refuse paths outside the workspace) and `client.test.ts` (SSE parsing,
auth header, error mapping).

### Step 4 — workspace files

New:

- `src/lib/sandbox/workspace.ts` — `identityPath(identity)`,
  `ensureWorkspace(identity)` (`mkdir -p`, `chown` to `SANDBOX_UID`, mode `0770`),
  `removeWorkspace(identity)`, `writeOwned(path, data)` (write then `chown`, so a
  file the browser uploads is editable in bash).

Changed:

- `src/lib/files/targets.ts` — the user target is the workspace directory, served
  by `createLocalFileProvider`. Its `realpath` hardening already covers symlinks a
  tenant points outside.
- `src/lib/council/files.ts` — same, against `council-<sandboxKey>`.
- `src/lib/council/sandbox.ts` — tools bound to the council identity.
- `src/lib/file-attachment.ts`, `src/lib/telegram/files.ts` — `writeOwned` under
  `uploads/` and `telegram_files/`.
- `src/app/api/chat/workspace-files/route.ts` — the local branch only.
- `src/lib/pi/tools/infra-tools.ts` — `requireWorkspace()` returns the workspace
  path.

Deleted: `src/lib/files/terminal-provider.ts`.

The seven `/api/files/*` routes, `src/lib/files/zip.ts` and
`readWorkspaceFile` keep their `FileProvider` calls.

### Step 5 — council lifecycle

- `src/lib/council/accounts.ts` — `deriveSandboxKey` stays; `sandboxIdentity`
  returns `{ id, dir, path }` from `councilIdentity`.
- `src/lib/council/sandbox.ts` — `ensureCouncilSandbox` becomes
  `ensureWorkspace(identity)` and a container-shape assertion; `destroyCouncilSandbox`
  becomes `removeWorkspace(identity)` plus `client.remove(identity)`.
- Deleted: `src/lib/council/commands.ts`, `containerAccountExists`,
  `isSafeAccountName`, the `getent`/`userdel`/`gpasswd` paths, and the retry that
  re-provisioned an account the container had cached.
- `Council.sandboxKey` keeps its meaning: a unique directory name.

Tests: `__tests__/lib/council/sandbox-lifecycle.test.ts` and `accounts.test.ts`
rewritten against the workspace functions.

### Step 6 — remove open-terminal, migrate the data

- Delete `src/lib/terminal/client.ts`, `src/lib/terminal/operations.ts` and their
  tests.
- `docker-compose.yml`: remove the `open-terminal` service and volume; add
  `saale_workspaces`, `sandbox-exec`, `saale-sandbox` and the sandbox network.
- `.env.example`, `README.md`, `.pi/skills/pi-agent-usage/SKILL.md`.
- `scripts/migrate-workspaces.mjs`, run once before the new stack starts.

## How a request flows

**A `bash` tool call.** Pi calls `bash.exec(command, cwd, { onData, signal,
timeout })`. The client posts to `/exec` with the identity. The service ensures
the container, runs the command with `docker exec`, streams demuxed output as SSE
chunks, and ends with the exit code. A `Stop` sends `DELETE /exec/:id`, which
signals the process group. A backgrounded server keeps running because the
container stays up, and it is stopped after the idle window.

**A `read`, `write` or `edit` tool call.** The app reads and writes
`/workspaces/<id>/…` directly. Tool paths resolve against the session cwd, which
is the same string inside the container, so a file written with `write` is the
file `cat` shows.

**A browse, upload, rename or zip.** `/api/files/*` resolves the target from the
session, builds the workspace root, and hands absolute paths to the
`local-provider`. Uploads land owned by `SANDBOX_UID`.

**A council.** The council's `sandboxKey` names a directory and an identity.
Creating the council creates the directory; deleting it removes the directory and
the container. Members' tools carry the council identity, and the owner's files
live in a different directory of the same volume.

## Isolation rules

1. **One directory per container.** Every container mounts
   `volume-subpath=<identity>`, so `/workspaces` holds exactly one entry.
   `/workspaces/user-b/x` does not exist in user A's container.
2. **The caller passes an identity, never a path or a directory.** The service
   derives the directory, the subpath and the container name from it. Path
   arguments are confined to `/workspaces/<id>` by the app and again by the
   service after `realpath`.
3. **The kernel view is checked.** Each new container's `/proc/self/mountinfo`
   must show one `/workspaces/` mount, naming the identity's subpath.

`SANDBOX_UID` (default `1000`) is baked into the image as the `agent` account, so
`whoami`, `id -un` and `$HOME` work. Ownership is a number recorded on files under
the volume; no account is created on the host, and teardown is `rm -rf` plus
`docker rm`.

Checked on this host (Docker 29.9.1, Compose v5.6.0):

- a container mounting subpath `userB` lists `userB` alone, and
  `/workspaces/userA/f` fails with `ENOENT`;
- `/proc/self/mountinfo` inside it has exactly one `/workspaces/` entry, naming
  the subpath;
- a directory `chown`ed to `1000:1000` is writable by a container running as uid
  1000, and the files it writes are readable from the app.

## Container spec

| Setting                                      | Value                                                                                                  |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `User`                                       | `<SANDBOX_UID>:<SANDBOX_GID>`                                                                          |
| `WorkingDir`                                 | `/workspaces/<id>`                                                                                     |
| `Env`                                        | `HOME=/workspaces/<id>`                                                                                |
| `Mounts`                                     | one: `type=volume`, `source=<SANDBOX_VOLUME>`, `target=/workspaces/<id>`, `VolumeOptions.Subpath=<id>` |
| `HostConfig.NetworkMode`                     | `SANDBOX_NETWORK`, where a command reaches the internet and nothing else in the compose project        |
| `HostConfig.CapDrop`                         | `["ALL"]`, `SecurityOpt: ["no-new-privileges"]`                                                        |
| `HostConfig.Init`                            | `true`, so backgrounded grandchildren are reaped                                                       |
| `HostConfig.Memory`, `PidsLimit`, `NanoCpus` | `SANDBOX_MEMORY`, `SANDBOX_PIDS`, `SANDBOX_CPUS`                                                       |
| `Labels`                                     | `saale.sandbox=<id>` for sweeping                                                                      |
| `Cmd`                                        | `sleep infinity`                                                                                       |

## Config

| Was                          | Becomes                                                                                                                      |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `OPEN_TERMINAL_URL`          | `SANDBOX_URL`                                                                                                                |
| `OPEN_TERMINAL_API_KEY`      | `SANDBOX_API_KEY`                                                                                                            |
| `OPEN_TERMINAL_MULTI_USER`   | (dropped)                                                                                                                    |
| `OPEN_TERMINAL_PACKAGES`     | `Dockerfile.sandbox`                                                                                                         |
| `OPEN_TERMINAL_PIP_PACKAGES` | `Dockerfile.sandbox`                                                                                                         |
| —                            | `SANDBOX_VOLUME`, `SANDBOX_CONTAINER_IMAGE`, `SANDBOX_NETWORK`, `SANDBOX_UID`, `SANDBOX_GID`, limits, `SANDBOX_IDLE_MINUTES` |

App mounts `<volume>:/workspaces`. With `SANDBOX_URL` unset, files work from the
same volume and `bash` is not offered.

## Migrating the live data

Live state: 5 users, 0 councils, three directories under `/home`
(`u7rv9dfnn`, `vcxyvmjy`, `user`) with small `uploads/` folders.

`scripts/migrate-workspaces.mjs`, run once with the old stack still up:

1. Read `user` ids and `Council.sandboxKey` values from Postgres, and derive the
   account name each maps to (`deriveOpenTerminalUsername`, kept in the script
   until cutover).
2. For each, tar `/home/<account>/{uploads,files,images,telegram_files}` out of the
   old container into `<volume>/user-<id>/` or `<volume>/council-<key>/`.
3. `chown -R <SANDBOX_UID>` the new directory.
4. Copy anything left in `/home` to `<volume>/_orphaned/` and print it.
5. Verify file counts and byte totals per directory before and after.
6. Keep `open-terminal-data` for one release.

## Deploy notes

- `volume-subpath` needs Docker 26 or newer. On an older host, bind
  `/srv/saale/workspaces/<id>` from the host at the same target and add
  `SANDBOX_WORKSPACES_HOST_DIR`; the rest is unchanged.
- Build the tenant image as part of `docker compose build`, and set
  `SANDBOX_CONTAINER_IMAGE` to the tag compose produces.
- The Docker socket is mounted into `sandbox-exec` only.
- The app runs as root in production today, which is what lets it `chown` inside
  the volume. If that ever changes, the `chown` calls need a helper with
  `CAP_CHOWN`.

## Out of scope

- Per-identity numeric uids. The spec builder takes one line to pass
  `--user <uid>` per identity; the volume already separates tenants.
- A file API on `sandbox-exec`. The app mounts the volume and reads it directly.
