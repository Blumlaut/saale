# Coder previews

A coder chat can start a dev server, and the Ports tab in the panel lists what is
listening and opens it. Nothing is registered per project: whatever listens inside the
chat's worktree shows up.

Each port gets a hostname of its own,
`https://<workspace>-<port>-<signature>.preview.example.com`, so the app inside it runs at
the root of its own origin and needs no base path. That is why this needs a wildcard
domain: **`*.preview.example.com`**.

Setting it up takes three steps.

## 1. The DNS record

```
*.preview.example.com.   A     <the IP of the server running Saale>
```

Use an AAAA record instead if you serve over IPv6. If your DNS provider is Cloudflare,
turn the proxy off for this record (grey cloud): the certificate challenge below needs to
reach your server.

## 2. The certificate

A wildcard cannot be issued by the usual HTTP challenge, so this needs a DNS challenge.
With certbot and Cloudflare DNS:

```bash
certbot certonly --dns-cloudflare \
  -d '*.preview.example.com' \
  --dns-cloudflare-credentials /root/.secrets/cloudflare.ini
```

For other providers the plugin name differs (`--dns-route53`, `--dns-google`,
`--dns-digitalocean`); the pattern is the same, and renewal works like every other
certbot certificate you already have.

The certificate must be for `*.preview.example.com` itself. A certificate for
`*.example.com` does not cover it.

## 3. The nginx vhost

Add this next to the one that serves Saale. The port is the preview listener that compose
publishes on the loopback address, so nothing on the internet reaches it directly.

```nginx
server {
    listen 443 ssl http2;
    server_name *.preview.example.com;
    ssl_certificate     /etc/letsencrypt/live/preview.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/preview.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8101;
        proxy_set_header Host $host;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_buffering off;          # hot reload and live output
        proxy_read_timeout 1h;
    }
}
```

Reload nginx: `nginx -t && systemctl reload nginx`.

## Check it

The proxy answers a health probe at a hostname in the wildcard, so one `curl` proves DNS,
the certificate, nginx and the listener:

```bash
curl -i https://probe.preview.example.com/__preview/health
# HTTP/2 200
# {"ok":true}
```

Changing `SANDBOX_PREVIEW_PORT` in `.env` means changing the port in the vhost with it.

## Using it

Open a chat, then have the agent start the project, or start it yourself in the
**Terminal** tab:

```bash
npm run dev            # or: python3 -m http.server 8080
```

Within a couple of seconds the port appears in **Ports**, with the command that started it
and a button that opens it. The row's menu copies the link or stops the server. Deleting
the chat stops everything it left running.

## Apps that pin their own hostname

Some frameworks only answer on the hostname they were configured with. A wildcard for the
preview domain keeps them happy in every workspace:

| Framework   | Setting                                                                                                  |
| ----------- | -------------------------------------------------------------------------------------------------------- |
| better-auth | `trustedOrigins: ["https://*.preview.example.com"]` in the auth config                                   |
| Django      | `ALLOWED_HOSTS = [".preview.example.com"]`, plus the same value in `CSRF_TRUSTED_ORIGINS` with the scheme |
| Rails       | `config.hosts << ".preview.example.com"`                                                                 |

Absolute URLs the app builds from its own base URL (OAuth redirect URIs, emailed links)
still point at the configured hostname, so set those to the preview link when you need to
walk through such a flow.

## If a preview does not load

| What you see                        | Why                                               | Fix                                                                                               |
| ----------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| The probe above does not answer     | DNS, certificate or nginx is wrong                | `dig +short probe.preview.example.com`, then `curl -kI https://probe.preview.example.com/__preview/health` from the server |
| "This preview link does not work"   | Wrong signature                                   | Copy the link from the Ports tab; an edited hostname stops working                                |
| "Nothing is listening on port 8080" | The server stopped, or it is bound to `127.0.0.1` | Restart it, and bind `0.0.0.0`                                                                    |
| The port says `loopback`            | The dev server only listens inside the container  | `npm run dev -- --host 0.0.0.0`; flask: `flask run --host 0.0.0.0`; Django: `runserver 0.0.0.0:8000` |
| `403 Blocked request`               | Vite rejects a host it was not told about         | `server.allowedHosts: ['.preview.example.com']` in `vite.config.ts`                               |
| A page of blocked `/_next/*`        | Next blocks cross-origin dev requests             | Nothing, when the app is opened through its preview link. A dev server addressed directly needs `allowedDevOrigins: ['*.preview.example.com']` |
| `Invalid origin` logged by the app  | It trusts only the hostname it was configured for | Add the preview domain to the app's trusted hosts, see above                                      |
| Previews are off                    | `BETTER_AUTH_URL` is `localhost` or an IP         | Set the public URL, or set `PREVIEW_DOMAIN="preview.example.com"`                                 |
