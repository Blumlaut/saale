# Install

## What you need

- Docker with Compose v2.
- A domain, if you want HTTPS or coder previews. Everything else works on `localhost`.

## First start

```bash
git clone https://github.com/Blumlaut/saale.git
cd saale
cp .env.example .env
```

Replace the four secrets in `.env`. Each is a random string:

```bash
openssl rand -base64 32   # BETTER_AUTH_SECRET
openssl rand -hex 32      # ENCRYPTION_KEY
openssl rand -hex 32      # SANDBOX_API_KEY
openssl rand -hex 32      # WORKER_API_KEY
```

`ENCRYPTION_KEY` must be 64 hex characters: it decrypts the mail passwords in the
database, and changing it later makes them unreadable.

Then:

```bash
docker compose up -d --build
```

That builds the images, applies the database migrations and starts the stack. Open
<http://localhost:3630> and create the first account. The first account is the admin.

## On a domain

Set the address people will use:

```dotenv
BETTER_AUTH_URL="https://saale.example.com"
```

```bash
docker compose up -d
```

Sessions, OAuth redirects, webhooks and preview hostnames all derive from that one
variable. Terminate TLS at your reverse proxy. A minimal nginx vhost:

```nginx
server {
    listen 443 ssl http2;
    server_name saale.example.com;
    ssl_certificate     /etc/letsencrypt/live/saale.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/saale.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3630;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_buffering off;          # chat and terminal streams arrive as they are written
        proxy_read_timeout 1h;
    }
}
```

Coder previews need a wildcard host and a certificate of their own: see
[previews.md](previews.md).

## What runs

| Service        | What it does                                                                |
| -------------- | --------------------------------------------------------------------------- |
| `web`          | The app, on port 3630.                                                      |
| `worker`       | Agent jobs, watchers and background work.                                   |
| `sandbox-exec` | Runs every agent command in a per-user container. Holds the Docker socket. |
| `voice`        | Speech to text for the composer.                                            |
| `searxng`      | Search backend for the web tools.                                           |
| `postgres`     | Database.                                                                   |
| `redis`        | Queue and live session state.                                               |

`docker compose up` also builds the image those per-user containers run
(`saale-sandbox`). They live outside the compose project, so `docker compose down` leaves
them alone.

A user's container mounts one directory of the `saale_workspaces` volume. That directory
is the whole of what the agent can read and write, and no other user's files are at any
path inside it.

## Keeping your data

`docker compose down` stops the stack and keeps every volume. `docker compose down -v`
deletes the volumes, which includes `saale_workspaces`: every user's files, repositories
and worktrees. Do not pass `-v` unless you mean it.

Back up `postgres_data` and `saale_workspaces` together. A database restored without the
volume has rows pointing at files that are not there.

## Updating

```bash
git pull
docker compose up -d --build
```

The migrations run before `web` and `worker` start, so nothing else is needed.
