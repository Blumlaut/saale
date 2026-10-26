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
  socket and owns every container. It mounts the volume too, so it can create an
  identity's directory before Docker uses it as a mount subpath.
- **`saale-sandbox`**, the tenant image: the package list `OPEN_TERMINAL_PACKAGES`
  carries today, plus node and npm, an `agent` account, and `$HOME/.local/bin`
  on `PATH`.

## Implementation steps

Each step is a commit that leaves `npm run check` green.

### Step 1 — identity and container spec

New:

- `src/lib/sandbox/identity.ts` — `parseIdentity(raw)`, `userIdentity(userId)`,
  `councilIdentity(sandboxKey)`. An identity is `user-<id>` or
  `council-<key>`, matching `/^(user|council)-[A-Za-z0-9_-]{1,64}$/`. It is the
  only handle a caller passes.
- `src/lib/sandbox/config.ts` — `SANDBOX_VOLUME`, `SANDBOX_CONTAINER_IMAGE`,
  `SANDBOX_NETWORK`, `SANDBOX_WORKSPACES_DIR`, `SANDBOX_USER`, `SANDBOX_UID`,
  `SANDBOX_GID`, `SANDBOX_MEMORY`, `SANDBOX_PIDS`, `SANDBOX_CPUS`,
  `SANDBOX_IDLE_MINUTES`, `SANDBOX_CONTAINER_TTL_DAYS`, `SANDBOX_URL`,
  `SANDBOX_API_KEY`, `SANDBOX_EXEC_PORT`.
- `src/lib/sandbox/spec.ts` — `containerSpec(identity, config)` returning the
  `dockerode` create options. Pure, so the isolation rules are testable.

Tests: `__tests__/lib/sandbox/spec.test.ts` asserts one mount per identity, its
`VolumeOptions.Subpath` equal to the identity, a `User` on both the container and
every exec, the sandbox network, `CapDrop: ["ALL"]` under `SANDBOX_USER=agent`,
and that a malformed identity throws.

### Step 2 — the `sandbox-exec` service

New:

- `src/sandbox/server.ts` — `node:http`, no framework. `GET /health`,
  `POST /exec`, `DELETE /exec/:id`, `DELETE /container/:identity`.
  `Authorization: Bearer <SANDBOX_API_KEY>`, identity in `X-Identity`.
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
AttachStderr })`, started with `{ hijack: true, stdin: true }`. The command is
  wrapped as `setsid bash -c <command>`, the shell upstream runs today
  (`sudo -u <account> bash -c`). The stream is demultiplexed with
  `docker.modem.demuxStream` into the two SSE lanes, and `exec.inspect()` supplies
  the exit code once it ends.
- The response head is written only once the container is up and the exec has
  started, so a refused working directory or an image that will not start is a
  status code instead of a stream that ends without an exit event.
- `POST /exec` answers `text/event-stream`:
  `event: started` (the exec id), then `event: chunk` with
  `{ stream: "stdout"|"stderr", data: <base64> }`, then
  `event: exit` with `{ exitCode, timedOut, durationMs }`. The request's `env`
  map is validated (name pattern, count, total size) and handed to `docker exec`;
  values reach no log line and no container config.
- Abort: the command runs under `setsid`, and its process group id is written to
  `/tmp/.saale-<execId>.pgid` inside the container. `DELETE /exec/:id` runs a
  second exec that signals the group, so a pipeline dies whole. The server also
  signals the group when `timeoutSeconds` expires and reports `timedOut`.
- `reapIdle()` stops a container idle past `SANDBOX_IDLE_MINUTES` and removes it
  past `SANDBOX_CONTAINER_TTL_DAYS`; `sweep()` runs at boot and stops labelled
  containers left by a previous process.

Wiring:

- `package.json` — `dockerode` + `@types/dockerode`, and a `build:sandbox`
  script that mirrors `build:worker`:

  ```sh
  esbuild src/sandbox/server.ts --bundle --platform=node --packages=external \
    --outfile=dist/sandbox.mjs --format=esm --target=node26
  ```

- `Dockerfile` — the `production-worker` target also copies `dist/sandbox.mjs`.
- `Dockerfile.sandbox` — `debian:trixie-slim`, `ARG SANDBOX_UID=1000`,
  `useradd -u $SANDBOX_UID -m -d /workspaces agent`, node 22 with npm (the image
  we run today has both), the current package list (chromium and its libraries,
  ffmpeg, imagemagick, build-essential, libssl/libffi/python dev headers, jq,
  curl, wget, ripgrep, fd-find, silversearcher-ag, git, `gh`),
  `pip install --break-system-packages yt-dlp`, `WORKDIR /workspaces`.
- `docker-compose.yml` — service `sandbox-exec` (app network, socket mounted,
  `command: node sandbox.mjs`), service build for `saale-sandbox`, volume
  `saale_workspaces` mounted at `/workspaces` in web and worker, network
  `saale-sandbox`.

Tests: `__tests__/sandbox/containers.test.ts` with an injected fake docker handle
(create options, reuse of a stopped container, demuxed chunks, exit code, group
kill on abort, sweep by label, idle stop, TTL removal), `mount-check.test.ts` for
the kernel-view assertion, and `server.test.ts` for the HTTP surface.

### Step 3 — client and Pi operations

New:

- `src/lib/sandbox/client.ts` — `isConfigured()`, `exec(identity, options)` as an
  async iterable of events, `kill(execId)`, `remove(identity)`, `health()`.
- `src/lib/sandbox/operations.ts` — `createSandboxOperations`, the four Pi
  operation objects:
  - `bash.exec` forwards `onData`, `signal` and `timeout` to `client.exec`, and
    maps a signal to `kill`;
  - `read`, `write`, `edit` go through `createLocalFileProvider` rooted at
    `identityPath(identity)`, so a path is confined textually and then resolved
    through `realpath`. A symlink a tenant creates cannot reach another
    tenant's directory, which matters because the app sees the whole volume.

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
  `userWorkspacePath(userId)`, `ensureWorkspace(identity)` (`mkdir -p`, mode
  `0770`), `removeWorkspace(identity)`, `writeOwned(path, data)` (write, then
  hand the file to the exec user), `writeWorkspaceFile(userId, relative, data)`.
  Ownership follows `SANDBOX_USER`: nothing to set while commands run as root.

Changed:

- `src/lib/files/targets.ts` — the user target is the workspace directory, served
  by `createLocalFileProvider`, which takes the owner for anything it creates.
  Its `realpath` hardening already covers symlinks a tenant points outside.
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
  `ensureWorkspace(identity)` plus a `client.health()` preflight;
  `destroyCouncilSandbox` becomes `client.removeContainer(identity)` plus
  `removeWorkspace(identity)`. The container-shape assertion is the service's
  mount check, which runs when the container is created.
- Deleted: `src/lib/council/commands.ts`, `containerAccountExists`,
  `isSafeAccountName`, the `getent`/`userdel`/`gpasswd` paths, and the retry that
  re-provisioned an account the container had cached.
- `Council.sandboxKey` keeps its meaning: a unique directory name.

Tests: `__tests__/lib/council/sandbox-lifecycle.test.ts` and `accounts.test.ts`
rewritten against the workspace functions.

### Step 6 — environment variables

New:

- `prisma/schema.prisma` — a `SandboxEnvVar` model: `userId`, `name`,
  `encryptedValue`, `@@unique([userId, name])`. The migration follows
  `.pi/skills/database-migrations`.
- `src/lib/sandbox/env.ts` — `resolveSandboxEnv(userId)` returning the map for
  one exec (see "Environment variables").
- `src/app/api/settings/sandbox-env/route.ts` — `GET` names, `PUT { name, value }`,
  `DELETE ?name=`. Every response carries names only.
- `src/components/integrations/sandbox-env-card.tsx` — the panel, modelled on
  `src/components/integrations/github-card.tsx`. Read
  `.pi/skills/saale-design/SKILL.md` before writing it.

Changed:

- `src/lib/sandbox/client.ts` — `exec` takes `env`.
- `src/lib/sandbox/operations.ts`, `src/lib/pi/session.ts` — pass
  `resolveSandboxEnv(userId)`; a council's sandbox passes the owner's.
- `src/lib/pi/processing-state.ts` — one line in `TERMINAL_PROMPT` naming the
  variables that are set.

Tests: name validation, precedence (the GitHub integration fills `GH_TOKEN` only
when the user has not set one), decrypt round trip, and an API test that a read
never returns a value.

### Step 7 — installs and container lifetime

Changed:

- `src/lib/sandbox/spec.ts` — `SANDBOX_USER`, the `PATH` with
  `$HOME/.local/bin`, and the capability set that follows the user (see
  "Installing packages").
- `src/lib/sandbox/containers.ts` — `stop` at idle, `remove` at TTL.
- `Dockerfile.sandbox` — `agent` gets `$HOME/.local/bin` on `PATH`, and the image
  ships `uv`/`pipx` alongside `pip`.

Tests: the spec test covers both `SANDBOX_USER` values; the reaper test asserts a
stop past the idle window and a removal past the TTL.

### Step 8 — remove open-terminal, migrate the data

- Delete `src/lib/terminal/client.ts`, `src/lib/terminal/operations.ts` and their
  tests.
- `docker-compose.yml`: remove the `open-terminal` service and volume; add
  `saale_workspaces`, `sandbox-exec`, `saale-sandbox` and the sandbox network.
- `.env.example`, `README.md`, `.pi/skills/pi-agent-usage/SKILL.md`.
- `workspaces-migrate` in `docker-compose.yml`, a one-shot service that copied
  each old `/home/<account>` into `<volume>/<identity>/` before web and worker
  started. It ran from this checkout, marked the volume, and was deleted once the
  move was done (see "The data move that ran").

### Step 9 — retire the env-var shaped integration

GitHub is the only integration whose whole job is a variable: a token, stored in
`GitHubAccount.encryptedToken`, injected as `GH_TOKEN`, plus a login name and
avatar for the card. Once `SandboxEnvVar` exists, that is one row the user adds.

Deleted:

- `src/lib/github/` (`client.ts`, `index.ts`), `src/app/api/integrations/github/`,
  `src/components/integrations/github-card.tsx`,
  `src/hooks/use-github-integration.ts`.
- The `github` entry in `src/lib/integrations/registry.ts`, its member of
  `IntegrationId`, its card and delete description in
  `src/app/dashboard/settings/tabs/integrations-tab.tsx`.
- The `GH_TOKEN` source in `src/lib/sandbox/env.ts` and the `getGitHubEnv` call in
  `src/lib/pi/session.ts`.
- `model GitHubAccount` and the `User.githubAccounts` relation, through the
  migration skill.

Existing tokens move in the migration itself: `GitHubAccount.encryptedToken` is
the same AES-256-GCM cipher under the same `ENCRYPTION_KEY`, so the SQL copies the
ciphertext into a `GH_TOKEN` row (skipping `enabled = false`, matching the old
injection rule) and drops the table. One deploy, no script to run first, and no
window in which a token exists only in a backup.

Lost with the card: the token check against `GET /user` and the connected login
and avatar. The env var editor lists `GH_TOKEN` like any other name, and the
agent finds `gh` authenticated because the variable is set.

The env vars panel and the remaining integrations live on the same settings tab:
`src/components/integrations/*` keeps `telegram-card.tsx` and `integration-box.tsx`,
and the new card sits beside them. Read `.pi/skills/saale-design/SKILL.md` before
building it.

Tests: an API test that a user's `GH_TOKEN` row is not returned by another user's
list, and a settings-tab test that the GitHub box is gone and the env vars card
renders its names.

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
`local-provider`. Uploads land owned by the container's command user.

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

`SANDBOX_USER` selects the account commands run as: `root` by default, which is
what lets an agent install packages, or `agent` for the tighter setting. Files in
the volume are owned by that account. No account is created on the host, and
teardown is `rm -rf` plus `docker rm`.

Checked on this host (Docker 29.9.1, Compose v5.6.0):

- a container mounting subpath `userB` lists `userB` alone, and
  `/workspaces/userA/f` fails with `ENOENT`;
- `/proc/self/mountinfo` inside it has exactly one `/workspaces/` entry, naming
  the subpath;
- a directory owned by the account a container runs as is writable by that
  container, and the files it writes are readable from the app;
- `apt-get install jq` succeeds as root with Docker's default capabilities, and
  fails under `--cap-drop ALL` (exit 100). That is the trade
  `SANDBOX_USER=agent` makes.

## Environment variables

`GH_TOKEN` already works this way: `getGitHubEnv(userId)` returns it and the
session injects it into every command so `gh` is authenticated. It becomes one
source among several.

**Storage.** A `SandboxEnvVar` table, in the shape `GitHubAccount` already uses:
`userId`, `name`, `encryptedValue` (`@/lib/crypto`), `@@unique([userId, name])`.
Secrets stay out of `AppSettings`, whose registry documents itself as
secret-free.

**Resolution** runs in the app at exec time (`src/lib/sandbox/env.ts`):

1. the user's `SandboxEnvVar` rows, decrypted;
2. `GH_TOKEN` from the GitHub integration, when the user set no `GH_TOKEN` of
   their own;
3. the per-call extras the session builds today.

That allowlist is all that is sent. `process.env` is never forwarded, so
`DATABASE_URL`, `ENCRYPTION_KEY` and `SANDBOX_API_KEY` stay in the app.

**Transport.** The exec request carries `env`. The service checks each name
(`/^[A-Z_][A-Z0-9_]{0,63}$/`), caps the count at 32 and the total at 32 KB, and
passes them to `docker exec` as `Env`. A value exists in the exec object and in
that one command's environment for as long as it runs, and the container's own
environment never carries it.

**Scope.** A chat command uses the acting user's variables. A council member
uses the council owner's.

**No cross-user leakage.** The leak vectors and what closes each one:

- Every query filters `userId`, including the resolution read. A background job
  resolves from `task.userId`, and a council from its owner's.
- Values are resolved per exec and never stored on a pooled agent session, a
  prompt, or a container. `agent-pool` caches sessions per user, so a value baked
  into one would live as long as the pool entry.
- Names, not values, go into `TERMINAL_PROMPT`. A write to the user's variables
  calls `evictUserSessions(userId)` from `@/lib/pi/agent-pool`, the path
  `applyUserSettingsPatch` already uses, so the rebuilt prompt lists the new set.
- The API returns names only, and the agent's `settings_list` / `settings_set`
  tools do not cover this table. A value never enters a transcript, a tool
  result, or a log line.
- Admin-wide variables stay out of this feature: a value defined for everyone is
  a sharing decision, and it would need its own scope and its own review.

Tests: a two-user API test (user B's list never contains user A's names), a
resolution test asserting the map for one user holds only their rows, and a
prompt test asserting it holds names and no values.

**The model knows names, never values.** `TERMINAL_PROMPT` gains a line listing
the variables that are set, so the agent knows `gh` is authenticated and which
integrations are live.

## Installing packages

Three tiers, all reachable from bash:

1. **In the image.** `Dockerfile.sandbox` carries what every workspace needs:
   today's `OPEN_TERMINAL_PACKAGES` list plus node, npm, `uv` and `pipx`.
2. **In the workspace.** `$HOME` is `/workspaces/<id>` and
   `$HOME/.local/bin` is on `PATH`, so `pip install --user`,
   `npm install -g` (`NPM_CONFIG_PREFIX` is `$HOME/.local`), `uv tool install`,
   `cargo install --root ~/.local` and `go install` with `GOBIN=$HOME/.local/bin`
   land in the volume and outlive the container.
3. **System packages.** `apt-get install` runs inside the container and lands in
   its writable layer. It survives a stop and is lost when the container is
   removed.

Tier 3 sets the default user: `SANDBOX_USER=root`. Root inside a container with
one directory mounted, its own network, no socket, no secrets in the container's
own environment, and Docker's default capability set is the posture the previous
terminal container had. A deployment that wants the tighter setting runs
`SANDBOX_USER=agent`: commands run as the image's `agent` account, `apt-get`
fails, tiers 1 and 2 keep working, and the volume needs a one-time
`chown -R agent:agent`.

Installs need egress, which the sandbox network provides. `apt-get`, `pip` and
`npm` reach the internet and nothing else in the compose project.

Container lifetime follows from tier 3: `reapIdle()` stops a container past
`SANDBOX_IDLE_MINUTES` and the writable layer survives, so an installed package
is still there next time. A changed limit is applied to the container with the
update API, which records it on the container, so a limit change does not cost
the layer. Removal happens past `SANDBOX_CONTAINER_TTL_DAYS`, and deploying a new
image means the next container is created from it. Anything that must survive is
either in the image (tier 1) or installed into `$HOME` (tier 2).

## Container spec

| Setting                                      | Value                                                                                                  |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `User`                                       | `SANDBOX_USER` (`root` by default, `agent` for the tighter setting)                                    |
| `WorkingDir`                                 | `/workspaces/<id>`                                                                                     |
| `Env`                                        | `HOME=/workspaces/<id>`, `PATH=…:/workspaces/<id>/.local/bin`                                          |
| `Mounts`                                     | one: `type=volume`, `source=<SANDBOX_VOLUME>`, `target=/workspaces/<id>`, `VolumeOptions.Subpath=<id>` |
| `HostConfig.NetworkMode`                     | `SANDBOX_NETWORK`, where a command reaches the internet and nothing else in the compose project        |
| `HostConfig.CapDrop` / `SecurityOpt`         | Docker's defaults; `["ALL"]` and `no-new-privileges` when `SANDBOX_USER=agent`                         |
| `HostConfig.Init`                            | `true`, so backgrounded grandchildren are reaped                                                       |
| `HostConfig.Memory`, `PidsLimit`, `NanoCpus` | `SANDBOX_MEMORY`, `SANDBOX_PIDS`, `SANDBOX_CPUS`                                                       |
| `Labels`                                     | `saale.sandbox=<id>` for sweeping                                                                      |
| `Cmd`                                        | `sleep infinity`                                                                                       |

## Config

| Was                          | Becomes                                                                                                                                                                                              |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OPEN_TERMINAL_URL`          | `SANDBOX_URL`                                                                                                                                                                                        |
| `OPEN_TERMINAL_API_KEY`      | `SANDBOX_API_KEY`                                                                                                                                                                                    |
| `OPEN_TERMINAL_MULTI_USER`   | (dropped)                                                                                                                                                                                            |
| `OPEN_TERMINAL_PACKAGES`     | `Dockerfile.sandbox`                                                                                                                                                                                 |
| `OPEN_TERMINAL_PIP_PACKAGES` | `Dockerfile.sandbox`                                                                                                                                                                                 |
| —                            | `SANDBOX_VOLUME`, `SANDBOX_CONTAINER_IMAGE`, `SANDBOX_NETWORK`, `SANDBOX_WORKSPACES_DIR`, `SANDBOX_USER`, `SANDBOX_UID`, `SANDBOX_GID`, limits, `SANDBOX_IDLE_MINUTES`, `SANDBOX_CONTAINER_TTL_DAYS` |

App mounts `<volume>:/workspaces`. With `SANDBOX_URL` unset, files work from the
same volume and `bash` is not offered.

## docker-compose wiring

The tenant containers live outside the compose project. `sandbox-exec` creates
them through the Docker socket, so every name it needs must be stable.

```yaml
services:
  web:
    volumes:
      - saale_workspaces:/workspaces
    environment:
      - SANDBOX_URL=http://sandbox-exec:8100
      - SANDBOX_API_KEY=${SANDBOX_API_KEY:?Set SANDBOX_API_KEY}
      - SANDBOX_WORKSPACES_DIR=/workspaces

  worker:
    volumes:
      - saale_workspaces:/workspaces
    environment:
      - SANDBOX_URL=http://sandbox-exec:8100
      - SANDBOX_API_KEY=${SANDBOX_API_KEY:?Set SANDBOX_API_KEY}
      - SANDBOX_WORKSPACES_DIR=/workspaces

  sandbox-exec:
    build:
      context: .
      target: production-worker
    image: saale-worker
    container_name: saale-sandbox-exec
    restart: unless-stopped
    command: ["node", "sandbox.mjs"]
    networks:
      - default
      - sandbox
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      # The service creates an identity's directory before Docker can use it as
      # a mount subpath. Tenant containers never see the volume root.
      - saale_workspaces:/workspaces
    environment:
      - SANDBOX_API_KEY=${SANDBOX_API_KEY:?Set SANDBOX_API_KEY}
      - SANDBOX_WORKSPACES_DIR=/workspaces
      - SANDBOX_VOLUME=saale_workspaces
      - SANDBOX_NETWORK=saale-sandbox
      - SANDBOX_CONTAINER_IMAGE=saale-sandbox
      - SANDBOX_UID=${SANDBOX_UID:-1000}
      - SANDBOX_USER=${SANDBOX_USER:-root}

  # The image the sandbox containers run. Built by `up --build`, exits at once.
  sandbox-image:
    image: saale-sandbox
    build:
      context: .
      dockerfile: Dockerfile.sandbox
    restart: "no"
    command: ["true"]

volumes:
  saale_workspaces:
    name: saale_workspaces

networks:
  sandbox:
    name: saale-sandbox
```

Details that matter:

- **The volume is compose-owned**, so a deploy creates it and a checkout needs no
  manual step. The `name:` is fixed so the socket side can reference it without
  the project prefix (`saale_`). `docker compose down -v` deletes user data;
  never pass `-v`.
- **The network is named explicitly** so `sandbox-exec` can attach a new
  container to it by name. Compose creates it before any service starts.
- **The tenant image builds with the stack.** It has no profile, so
  `docker compose up -d --build` builds it along with the app. The profile it
  used to carry kept the deploy from building it, and then the first command
  failed with a missing image. The dev overlay puts the profile back: dev runs
  against the image CI builds.

- **Dev overlay**: `sandbox-exec` in `docker-compose.dev.yml` uses
  `build.target: development`, the repo bind mount, the socket, and
  `command: sh -c "npx tsx --watch src/sandbox/server.ts"`, the same shape as the
  worker.
- **Leftover containers**: they are not part of the project, so `compose down`
  leaves them running. `sweep()` at startup stops anything labelled
  `saale.sandbox`.
- **Scratch space**: the agent writes throwaway output to `.tmp/` in its
  workspace, which is the one directory the file tools and a command both see.
  The service empties entries older than `SANDBOX_TMP_HOURS` (72 by default)
  from every workspace on its reaper interval.
- `sandbox-exec` mounts the socket, so it is root-equivalent on the host, the
  same privilege the terminal container has today.

A fresh box needs one command: `docker compose up -d --build`. It builds the app
and the tenant image, runs the schema migration, and starts. On a host that ran
open-terminal, add `--remove-orphans`: the old terminal container is no longer
part of the project.

## The data move that ran

The live instance moved on 2026-10-22: `workspaces-migrate` copied five old homes
into `saale_workspaces` — one user's 6 files, one user's 8465 files (1.1 GB), and
three unclaimed `/home` directories parked under `_orphaned/` — then wrote
`.migrated-from-open-terminal` into the volume. The service, its script and the
`open_terminal_data` volume were removed afterwards, so nothing repeats the copy
on later deploys.

Two things it had to get right, worth keeping in mind for any future move of this
volume:

- `chown` follows symlinks, and old homes hold dangling ones (a `.config/pulse`
  runtime socket, for one). Ownership goes through `lchown`, and a path that
  still fails is reported without aborting the move.
- A copy is assembled beside its destination and renamed into place, so a crash
  mid-copy cannot leave a workspace that looks complete.

The old volume, `saale_open-terminal-data`, still holds the pre-move data. Delete
it (`docker volume rm saale_open-terminal-data`) once the workspaces have been
checked.

## Deploy notes

- The first deploy after this change stops the old terminal service. Keep the old
  volume until the workspaces have been checked: `docker volume rm
saale_open-terminal-data` is the last step, and an orphaned `user` home stays
  in `<volume>/_orphaned/user` either way.
- `volume-subpath` needs Docker 26 or newer. On an older host, bind
  `/srv/saale/workspaces/<id>` from the host at the same target and add
  `SANDBOX_WORKSPACES_HOST_DIR`; the rest is unchanged.
- The Docker socket is mounted into `sandbox-exec` only.
- The app runs as root in production today, which is what lets it `chown` inside
  the volume. If that ever changes, the `chown` calls need a helper with
  `CAP_CHOWN`.

## Parity check

What the agent sees today, and what it sees after, for the features in use:

| Today                                                                     | After                                                         |
| ------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `sudo -u <account> bash -c <cmd>`, non-root                               | `setsid bash -c <cmd>` as `root` (or `agent`)                 |
| cwd `/home/<account>`                                                     | cwd `/workspaces/<id>`                                        |
| `uploads/`, `files/`, `images/`, `telegram_files/`                        | same names, carried over by the migration                     |
| output polled every 5 s                                                   | streamed as produced                                          |
| long output loses its start, with a marker                                | nothing dropped; Pi truncates for the model                   |
| `exit_code: null` when a process disappears                               | real code, `128 + signal`                                     |
| stat through the parent listing                                           | real stat                                                     |
| unknown files as `application/octet-stream`                               | extension on the app side, bytes sniffed for images           |
| `modified` in seconds                                                     | milliseconds                                                  |
| `GH_TOKEN` merged into the container env, readable from `/proc/1/environ` | passed to that one command                                    |
| no user-defined variables                                                 | `SandboxEnvVar` rows, encrypted, resolved per exec            |
| `pip install --user` works, `apt-get` fails                               | `apt-get` works inside the container, installs survive a stop |
| compose network: reaches Postgres and Redis                               | `saale-sandbox`: internet only                                |
| packages from `OPEN_TERMINAL_PACKAGES` at boot                            | `Dockerfile.sandbox`, same list plus node 22                  |
| sessions accumulate per chat                                              | one container per identity, reaped after the idle window      |
| teardown via `userdel` / `gpasswd` / `groupdel`                           | `rm -rf` and `docker rm`                                      |
| other tenants' homes readable through the file API                        | absent from the container                                     |
| read/write/edit, image preview, `show_file`, zip, browser                 | unchanged                                                     |

One behaviour changes: a background process started in a chat lives as long as
the container stays warm, then it is stopped. `SANDBOX_IDLE_MINUTES` (default 240) is the knob, and a container with a command
still running in it is never reaped; upstream kept such processes alive until the
container restarted for some other reason.

## Out of scope

- Per-identity numeric uids. The spec builder takes one line to pass
  `--user <uid>` per identity; the volume already separates tenants.
- A file API on `sandbox-exec`. The app mounts the volume and reads it directly.
