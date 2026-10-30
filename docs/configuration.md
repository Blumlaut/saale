# Configuration

Everything lives in `.env` next to the compose file. `.env.example` lists every variable
with a comment; this page covers the ones worth understanding before a deployment.

## Required

| Variable             | What it does                                                       |
| -------------------- | ------------------------------------------------------------------ |
| `BETTER_AUTH_URL`    | The public URL. Sessions, redirects, webhooks and previews use it. |
| `BETTER_AUTH_SECRET` | Encrypts sessions. 32+ random characters.                          |
| `ENCRYPTION_KEY`     | Decrypts stored mail passwords. 64 hex characters.                 |
| `SANDBOX_API_KEY`    | Shared key between the app and `sandbox-exec`.                     |
| `WORKER_API_KEY`     | Shared key for the worker's calls back into the app.               |

`DATABASE_URL`, `REDIS_URL` and `SEARXNG_URL` are set by the compose file. Set them
yourself only when you run the app outside Docker.

## Address and access

| Variable               | Default          | What it does                                                           |
| ---------------------- | ---------------- | ---------------------------------------------------------------------- |
| `PREVIEW_DOMAIN`       | `preview.<host>` | Wildcard the coder previews are served on. See [previews.md](previews.md). |
| `AUTH_TRUSTED_ORIGINS` | none             | Extra origins allowed to sign in, comma separated. Wildcards are fine. |
| `AUTH_RATE_LIMIT`      | on               | `off` disables the per-IP limit on the auth endpoints.                 |
| `RATE_LIMIT_MAX`       | `60`             | Requests per IP and path per minute.                                   |
| `RATE_LIMIT_WINDOW_MS` | `60000`          | The window `RATE_LIMIT_MAX` is counted over.                           |

Behind a reverse proxy, `AUTH_TRUSTED_ORIGINS` is what lets a second hostname sign in.
A preview hostname changes per port, so give the wildcard form rather than one host:

```dotenv
AUTH_TRUSTED_ORIGINS="https://*.preview.example.com"
```

## Sandbox

The agent runs commands in a container of its own, one per user.

| Variable                     | Default | What it does                                                     |
| ---------------------------- | ------- | ---------------------------------------------------------------- |
| `SANDBOX_USER`               | `root`  | `root` lets the agent install packages. `agent` is tighter.      |
| `SANDBOX_MEMORY`             | `4g`    | Memory limit per container.                                     |
| `SANDBOX_PIDS`               | `4096`  | Process limit. Threads count too, and a dev server needs many.  |
| `SANDBOX_CPUS`               | `2`     | CPU limit per container.                                        |
| `SANDBOX_IDLE_MINUTES`       | `240`   | Minutes before an idle container is stopped.                    |
| `SANDBOX_CONTAINER_TTL_DAYS` | `7`     | Days before a container is removed. `0` keeps them.             |
| `SANDBOX_TMP_HOURS`          | `72`    | Hours before a workspace's `.tmp/` is emptied. `0` keeps it.    |

A changed `SANDBOX_MEMORY`, `SANDBOX_PIDS` or `SANDBOX_CPUS` reaches the container on its
next command, without replacing it, so an installed package and a running service stay
where they are. Redeploy the stack first: the limits reach containers through
`sandbox-exec`'s environment, and only after that service is recreated.

`SANDBOX_CONTAINER_TTL_DAYS` removes a container once it is that old, and takes whatever
was written to the container's own filesystem with it: `apt-get`, a global `pip`. Packages
an agent installs for itself survive, because they live in the workspaces volume:
`pip install --user`, `npm install -g` (the image points npm's global prefix at
`$HOME/.local`) and anything else under `~/.local/bin`. An installation that has to keep
its system packages sets `SANDBOX_CONTAINER_TTL_DAYS=0`.

## Voice input

The composer's microphone is decoded by a faster-whisper server in the `voice` container.
It loads a model only when a recording arrives, and unloads it minutes after the last one.

| Variable         | Default                       | What it does                                  |
| ---------------- | ----------------------------- | --------------------------------------------- |
| `VOICE_ENABLED`  | `1`                           | `0` removes the microphone.                   |
| `VOICE_URL`      | `http://voice:8000`           | A transcription server elsewhere. Empty is off. |
| `VOICE_MODEL`    | `Systran/faster-whisper-small` | Any CTranslate2 Whisper model id.             |
| `VOICE_LANGUAGE` | detected                      | Force a language, e.g. `de`.                  |

That container downloads a few hundred MB on its first start. A 502 from the composer
means the app reached `VOICE_URL` and nothing answered there, so read that container's
logs first.

## Push, Telegram and search

| Variable                 | What it does                                                                 |
| ------------------------ | ---------------------------------------------------------------------------- |
| `VAPID_PUBLIC_KEY`       | Web Push key pair, from `npx web-push generate-vapid-keys`.                  |
| `VAPID_PRIVATE_KEY`      | The other half. Rotating it drops every subscription.                        |
| `VAPID_SUBJECT`          | Contact URI for the push service. Defaults to a `mailto:` on the app's host. |
| `TELEGRAM_OIDC_CLIENT_ID` / `_SECRET` | Enables sign-in with the instance's Telegram bot.               |
| `TELEGRAM_OUTBOUND_TTL_DAYS` | How long a sent message stays a reply target. Default `90`.              |
| `SEARXNG_URL`            | Search backend for the web tools.                                            |
| `ARCTIC_SHIFT_URL`       | Archive the web tools read Reddit through, because Reddit blocks servers.    |

## Modules

| Variable          | Default | What it does                                                 |
| ----------------- | ------- | ------------------------------------------------------------ |
| `COUNCIL_ENABLED` | `1`     | `0` removes the council module: nav, routes and tools.       |
| `PI_OFFLINE`      | unset   | Set it to stop the model catalog from reaching the network.  |

## Workspace variables

A command an agent runs in a workspace sees the user's own variables (Settings,
Integrations) and four that Saale sets:

| Variable               | What it holds                    |
| ---------------------- | -------------------------------- |
| `SAALE_CHAT_ID`        | the chat the command belongs to  |
| `SAALE_MODEL`          | the model answering in that chat |
| `SAALE_MODEL_PROVIDER` | the provider serving that model  |
| `SAALE_THINKING_LEVEL` | the thinking level it runs at    |

They are read when a command starts, so a model switch mid-chat shows up in the next
command. A variable the user sets with the same name wins.

## Development only

| Variable               | What it does                                                          |
| ---------------------- | --------------------------------------------------------------------- |
| `ALLOWED_DEV_ORIGINS`  | Hosts a dev server accepts requests from. A LAN address or a tunnel.  |
| `NGROK_URL`            | A tunnel in front of the app, used to build the Telegram webhook URL. |
| `PI_GLOBAL_PLUGINS_DIR` | Pins the directory global plugins are read from.                     |
