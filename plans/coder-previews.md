# Coder Previews

A coder chat can start a dev server, and the user can open it in the panel. The agent
needs no tool for this: it runs the project the way it always would (`npm run dev`,
`python -m http.server 8080`, `flask run`), Saale notices the port, and the panel grows an
entry with the URL, the process and a kill button. Deleting the chat kills what it started.

Every port gets its own origin: `https://<workspace>-<port>-<token>.preview.<apex>`
reverse-proxies to `http://saale-sandbox-<identity>:<port>`. An app served at the root of its own hostname
emits the URLs it always emits, sets its own cookies, and needs no rewriting, no injected
`<base>` and no base-path configuration. That is the whole reason for the wildcard host.

## Decisions

Settled in the kickoff conversation:

- **One method: a hostname per port.** Path mounting (`/preview/<name>/`) was considered
  and dropped. It needs HTML/CSS/`Location` rewriting plus `<base>` injection, and it
  still breaks an app that builds root-absolute URLs in JavaScript (`fetch('/api/x')`),
  which is the failure ammit users work around by serving the app under a configured base
  path. A per-port hostname deletes the entire problem instead of mitigating it.
- **No agent tooling.** No `app_start`, no `preview_open`. The port list comes from the
  processes already running in the container, so the agent's own commands are the API. The
  coder prompt gains one sentence about the two dev-server host allowlists (below) and
  nothing else.
- **The proxy lives in `sandbox-exec`.** That service is on both networks, so it can dial
  `saale-sandbox-<identity>` by name. `web` is on the default network only and cannot reach
  a tenant, and a Next route handler cannot accept a WebSocket upgrade, so putting the
  proxy in the app would break HMR for every Vite and Next project.
- **Discovery reads `/proc`.** The sandbox image has neither `ss` nor `lsof`, so the port
  list comes from `/proc/net/tcp{,6}` (listening sockets are `st == 0A`), and each socket
  inode maps to a pid through `/proc/<pid>/fd`, which also gives the command line and the
  cwd.
- **The token is deterministic.** `HMAC(SANDBOX_API_KEY, "saale:preview:<identity>:<port>")`,
  hex, truncated to 8 bytes. Stable across reloads, so a preview survives a refresh and
  can be bookmarked. No expiry, no server state, no database table: possession of the URL
  is access to that port, like a share link, and the port stops answering the moment its
  process dies.
- **The label carries a hash of the workspace, not the workspace.** A DNS label allows 63
  characters and a user id alone can be 32 of them, next to a port and a token, in a name
  that is case-insensitive. Ten hex characters of `sha256(identity)` keep the label at 33
  however long the id is, keep the id out of a URL that gets pasted around, and cannot be
  broken by a browser lowercasing the host. The proxy already knows which containers
  exist, so it maps the slug back to the identity and the container from that list.
- **The domain comes from `BETTER_AUTH_URL`.** `<scheme>://preview.<host>`, so a deployment
  sets no new variable. `PREVIEW_DOMAIN` overrides it, and previews switch off when the
  derived host is `localhost` or an IP.
- **A loopback-bound port gets the hint instead of a proxy.** Nothing outside the container
  can dial `127.0.0.1` there, so the row says to bind `0.0.0.0`.
- **Saale allows its own frames.** The app's CSP is `default-src 'self'`, which blocks the
  iframe before the browser ever asks the proxy. The middleware adds
  `frame-src 'self' <scheme>://*.<preview domain>`, and nothing else.
- **The setup lives where the previews would be.** The Ports tab prints the nginx block,
  filled in with the derived domain (or `preview.example.com` while previews are off), with
  a copy button and a check that goes through the public hostname. A settings page would be
  a second place to look; this one appears exactly when a preview is missing.
- **The preview listener is a second face of the service, on its own port.** Port
  `SANDBOX_PREVIEW_PORT` serves previews only: the host-and-token handshake, and one
  `__preview/health` endpoint so the settings page can prove that DNS, TLS and nginx are in
  place. The admin API keeps its bearer check on `SANDBOX_PORT` and is not reachable
  through a preview hostname.
- **Long-lived connections are the normal case.** An HMR socket stays open for the length
  of the session, so the listener sets no response timeout, the bridge streams instead of
  buffering, and nginx turns buffering off for the vhost.
- **The container's toolchain is the preview's toolchain.** Anything that runs there
  (`vite`, `next`, `python3 -m http.server`) can publish a port, and nothing has to be
  installed in the app's image for previews to work.

## Setup for a deployment

Three one-time steps, then nothing per project, chat or port. The README carries them, and
the Ports tab prints the same block with this deployment's domain filled in, with a check
button that proves it works, so nobody has to guess.

1. DNS: `*.preview.example.com A <ip>`.
2. A certificate for `*.preview.example.com`. Wildcards need DNS-01:
   `certbot certonly --dns-cloudflare -d '*.preview.example.com' --dns-cloudflare-credentials …`.
   A `*.example.com` cert does **not** cover `*.preview.example.com`; the exact name has to
   be issued.
3. One nginx vhost:

```nginx
server {
    listen 443 ssl http2;
    server_name *.preview.example.com;
    ssl_certificate     /etc/letsencrypt/live/preview.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/preview.example.com/privkey.pem;
    location / {
        proxy_pass http://127.0.0.1:8101;
        proxy_set_header Host $host;          # the proxy reads port and token from it
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_buffering off;                  # HMR and SSE
        proxy_read_timeout 1h;
    }
}
```

Compose publishes `8101` on `sandbox-exec` and binds it to `127.0.0.1`, so only the proxy
on the same host can reach the listener. Saale's own CSP already allows the frame; a
reverse proxy that sets a CSP of its own has to allow it too.

## How a preview comes up

1. The agent (or the user, in the Terminal tab) starts a dev server. It binds a port in the
   container.
2. The panel polls `GET /api/coder/sessions/:id/ports` every 3s while the Ports tab is
   visible (and on focus, like the worktree poll). The route asks the service
   `GET /ports` for the identity and returns what it finds, each entry with a minted URL.
3. `GET /ports` in the service execs a `/proc` read, parses the listening sockets, maps
   inodes to pids, and returns `{ port, address, pid, command, cwd, loopback }`. Entries
   whose cwd is outside the chat's worktree are dropped by the app route, so a port is only
   ever attributed to the chat that owns it.
4. The browser loads `https://3c21cf2806-5173-<token>.preview.example.com/x`. nginx
   forwards to 8101 with `Host` intact. The proxy reads `<slug>-<port>-<token>`, turns the
   slug back into a workspace from the containers that carry the `saale.sandbox` label
   (one list serves every request for a few seconds), verifies the HMAC over that identity
   and the port, and dials `http://saale-sandbox-<identity>:5173/x` with `Host` set to the
   preview hostname.
5. Unknown host, bad token, or a port that stopped listening all get a small HTML page that
   says so. Nothing else on the preview listener is reachable.
6. WebSocket upgrades take the same path through a `net` socket, so Vite HMR and
   `socket.io` reconnect work.
7. The kill button calls `POST /api/coder/sessions/:id/ports/:port/kill`, which kills the
   pid the listener belongs to.

## Files

Service (`src/sandbox/`, bundled into `dist/sandbox.mjs` with `@/` paths):

- `ports.ts` — parsing only: `/proc/net/tcp{,6}` lines to listening sockets (state `0A`,
  port from hex, address form, inode), and the fd scan to an inode's pid, cwd and command.
  Pure functions, fixtures in the tests.
- `preview-proxy.ts` — the listener on `SANDBOX_PREVIEW_PORT`: host parsing, token
  verification, HTTP forwarding with the request/response pipes, `net` upgrade bridge,
  error pages. No rewriting and no `<base>` injection; Node's `http` and `net` carry it,
  with no proxy package added.
- `server.ts` — `GET /ports`, `POST /ports/:port/kill`, and starting the preview listener
  next to the API listener. Bearer auth and `X-Identity` unchanged, so the admin API stays
  where it is.
- `containers.ts` — a `collect(identity, request)` helper for the one-shot execs the
  discovery needs; `manager.run` already streams, this drains it into a string.

Shared (`src/lib/`):

- `preview/token.ts` — `previewToken({ identity, chatId, port })` and
  `verifyPreviewToken(hostname)`. Imported by both the app and the service, so the format
  cannot drift.
- `preview/url.ts` — the derived domain, `previewIdentitySlug()`, `<slug>-<port>-<token>`,
  the reverse direction, and the setup block. Refuses a label of any other shape.
- `preview/config.ts` — `previewDomain()` from `PREVIEW_DOMAIN` or `BETTER_AUTH_URL`;
  `enabled`.
- `sandbox/config.ts` — `previewPort` (`SANDBOX_PREVIEW_PORT`, `0` disables).

App:

- `src/lib/coder/ports.ts` — `listChatPorts(userId, sessionId)`: resolve the worktree,
  ask the service, keep the entries whose cwd is inside the worktree, mint URLs.
  `killChatPort(userId, sessionId, port)` with the same ownership check.
- `src/app/api/coder/sessions/[sessionId]/ports/route.ts` and `.../ports/[port]/kill/route.ts`
  — thin, session-scoped, `userId` on every query.
- `src/components/coder/ports-view.tsx` — the Ports tab: one row per port (port number,
  command, URL, copy, open in new tab), an iframe for the selected one with reload and
  width control, a kill button per row, the loopback hint, and an empty state that says to
  run the project in the terminal.
- `src/components/coder/worktree-panel.tsx` — fourth tab, badge with the count.
- `src/lib/coder/worktree-removal.ts` — `stopProcesses` also sweeps by cwd (see Cleanup).
- `src/lib/pi/coder-prompt.ts` — one paragraph: dev servers are reachable from the panel,
  and the two host allowlists.
- `src/components/coder/setup` in the Ports tab — the nginx block with a copy button, and a
  check that probes `https://probe.<domain>/__preview/health` at the wildcard host, so a
  green answer means DNS, the certificate, nginx and the listener are all in place.
- `src/middleware.ts` — `frame-src` for the wildcard host, without which the iframe is
  blocked by Saale's own `default-src 'self'`.

## Cleanup

Three passes, because a dev server usually does not have its directory in its command
line:

- `stopTerminalExecs` already stops what the Terminal panel started.
- `pkill -f <worktree path>` stays, and catches processes whose arguments name it.
- New: a cwd sweep. `for p in /proc/[0-9]*; do readlink "$p/cwd"` and `kill` the ones under
  the worktree, skipping `$$` and its own exec. This is what catches
  `python3 -m http.server 8080`, whose command line says nothing about where it runs.

The same sweep runs on chat delete (existing `removeChatWorktree` path) and when a project
is deleted. A kill from the panel reuses the same command with a single pid.

## Tests

Parsing and tokens are pure, so they are unit tests with real fixtures:

- `/proc/net/tcp` fixture lines: wildcard IPv4 (reachable), loopback-only (flagged),
  docker's `127.0.0.11` resolver (dropped), the same port on `tcp6` (merged into one entry),
  a non-listening socket (`01`, dropped), a malformed line (skipped, not thrown).
- fd-scan fixture: an inode only one pid holds, an inode no pid holds (reported with no
  command), a pid with an unreadable cwd.
- Token: sign then verify round-trips; a tampered token, a token for another port, and a
  token for another identity are all refused; `containerName` is derived from the identity
  in the token, never from the request.
- Hostname: `3c21cf2806-5173-<token>.preview.example.com` parses; uppercase, a missing
  port, a bare `preview.example.com`, a port out of range, an id where the slug belongs,
  and a token of the wrong length are refused.
- Label width: a 32 character user id at port 65535 still fits, which is the case that
  used to throw and take the whole Ports tab down with it.
- Slug lookup: a running container's slug resolves to its identity, an unknown slug gives
  null, and a burst of requests shares one container list.
- Proxy, against a real `http.createServer` upstream: path, query and `Host` arrive
  unchanged; a response body passes through byte for byte; a 502 page when nothing listens;
  a real WebSocket echo through the upgrade bridge (both directions).
- Discovery route: missing bearer is 401; a port whose cwd is outside the chat's worktree is
  absent from the app route's answer; a chat with no worktree is 404.
- Kill route: kills the pid from the fixture, and an unknown port is 404.
- Cleanup: real `sleep` processes with a fake `/proc` tree of symlinks, one inside the
  worktree and one outside, assert only the inside one dies.
- Prompt: the preview paragraph is present for a coder chat and absent from the chat prompt.
- E2E: the Ports tab lists a mocked port, opens the iframe, and the kill button posts; the
  four tabs fit at 320px and 375px. Layout checks reuse the coder spec's mocked API so no
  container is needed.

## Risks

- **Dev-server host allowlists.** Vite answers `403 Blocked request` and Next 15.2+ blocks
  `/_next/*` from an origin it was not told about. Vite's `allowedHosts` and Next's
  `allowedDevOrigins` both take a leading-dot or wildcard form, so one entry covers every
  preview host. The panel shows the upstream status and body, so the failure is visible as
  itself rather than a blank frame, and the prompt names both knobs.
- **Loopback binds.** `flask run` and friends listen on `127.0.0.1` by default and cannot be
  reached from another container, so that row carries the `0.0.0.0` hint.
- **Framing.** An app that sends `X-Frame-Options: DENY` (or `frame-ancestors 'none'`) can
  still be opened in a new tab. The panel always offers that.
- **Wildcard prerequisite.** DNS-01 credentials are the one thing an operator might not
  have. Previews stay off when the domain cannot be derived, and the settings page says
  why rather than shipping a `location` block that would work for half the apps.
- **`/proc` cost.** Two execs per poll, ~40ms in a container that is already up. Polling
  stops when the tab is closed; the container's cold start is `ensure`'s existing problem.
- **Shareable links.** The token has no expiry by design. It only opens a port that is
  currently listening in the token owner's container, and it stops working with the
  process, the chat, or the container's idle reap.
- **Tenant isolation.** The identity comes from the signed hostname, the container name is
  derived from it, and the app route refuses a port whose cwd is not in the caller's
  worktree. A user can never mint a URL for somebody else's container.

## Phases

1. **Tokens and hostnames** (`src/lib/preview/`), with the tests above.
2. **Discovery** (`src/sandbox/ports.ts`, `GET /ports`, `containers.ts` `collect`).
3. **Proxy listener** (`src/sandbox/preview-proxy.ts`), HTTP then WebSocket, with the
   upstream fixture tests.
4. **Kill and cwd sweep**, wired into `worktree-removal.ts`.
5. **App routes** (`src/lib/coder/ports.ts` and the two API routes).
6. **Ports tab** (design skill first), plus the badge and the empty state.
7. **Settings → Previews** with the printed block and the probe.
8. **Compose, README, `.pi/skills`**: publish 8101, document DNS/cert/nginx and the two
   framework allowlists.
9. **E2E** and the 320/375 layout checks.

No schema change and no migration.

## Out of scope

Path mounting, tunnelling anything that is not a TCP port in the tenant container, TLS
termination by Saale, sharing a preview with a second user, per-port quotas, a reverse
proxy template system per app, and ammit's manual target registry (the feature this
replaces).
