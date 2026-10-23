/**
 * The preview listener.
 *
 * A request for `<slug>-<port>-<token>.<preview domain>` is a request for one
 * port of one workspace. The slug is turned back into the workspace it hashes
 * from, the signature in the hostname is checked against it, the container is
 * dialled by name on the sandbox network, and the request is passed
 * through as it stands: the app inside sees its own hostname at the root of its
 * own origin, so it builds the URLs it always builds.
 *
 * WebSocket upgrades take the same route over a raw socket, which is what makes
 * a Vite HMR client work.
 */

import http from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";
import { parsePreviewHost } from "@/lib/preview/url";
import { verifyPreviewToken } from "@/lib/preview/token";
import { containerName } from "@/lib/sandbox/spec";

/** Answered at the wildcard host, so an operator can prove DNS, TLS and nginx. */
export const PREVIEW_HEALTH_PATH = "/__preview/health";

/** A held connection is normal here: HMR, SSE and a streaming response. */
const NO_TIMEOUT = 0;

export interface PreviewProxyOptions {
  /** `SANDBOX_API_KEY`: the key the app signs preview URLs with. */
  key: string;
  /** The workspace a hostname's slug stands for, or null. */
  resolveIdentity: (slug: string) => Promise<string | null> | string | null;
  /** Where a workspace's container answers. Docker's DNS by default. */
  upstreamHost?: (identity: string) => string;
}

interface PreviewTarget {
  identity: string;
  port: number;
}

function page(title: string, detail: string, hint?: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
  :root { color-scheme: light dark }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px;
    font: 14px/1.5 ui-sans-serif, system-ui, sans-serif; background: #0b0b0c; color: #e7e7e9 }
  @media (prefers-color-scheme: light) { body { background: #fafafa; color: #18181b } }
  main { max-width: 34rem; display: flex; flex-direction: column; gap: 8px }
  h1 { margin: 0; font-size: 15px; font-weight: 600 }
  p { margin: 0; opacity: .75 }
  code { font-family: ui-monospace, monospace; font-size: 12px; padding: 1px 4px;
    border-radius: 4px; background: rgba(127,127,127,.16) }
</style></head>
<body><main><h1>${title}</h1><p>${detail}</p>${hint ? `<p>${hint}</p>` : ""}</main></body></html>`;
}

const NOT_FOUND_PAGE = page(
  "This preview link does not work",
  "The address does not name a port in a workspace on this server, or its signature is wrong.",
  "Open the Ports tab on the chat and use the link there.",
);

function unavailablePage(port: number): string {
  return page(
    `Nothing is listening on port ${port}`,
    "The workspace is there, but no process is accepting connections on that port.",
    `Start the server again in the chat's Terminal tab. If it is bound to <code>127.0.0.1</code>, bind <code>0.0.0.0</code> instead, or nothing outside the container can reach it.`,
  );
}

function sendPage(
  res: http.ServerResponse,
  status: number,
  body: string,
  extra: Record<string, string> = {},
): void {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    ...extra,
  });
  res.end(body);
}

/** A request's headers, minus the ones this hop owns. */
function forwardHeaders(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const forwarded: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (name === "connection" || name === "keep-alive" || name === "transfer-encoding") continue;
    forwarded[name] = value;
  }
  return forwarded;
}

export function createPreviewProxy(options: PreviewProxyOptions): http.Server {
  const upstreamHost = options.upstreamHost ?? containerName;
  const agent = new http.Agent({ keepAlive: true, maxSockets: 256 });

  async function resolveTarget(hostHeader: string | undefined): Promise<PreviewTarget | null> {
    if (!hostHeader) return null;
    const parsed = parsePreviewHost(hostHeader);
    if (!parsed) return null;
    // A slug that names no workspace gets the same answer as a bad signature,
    // so a hostname says nothing about which workspaces this server has.
    const identity = await options.resolveIdentity(parsed.slug);
    if (!identity) return null;
    const scope = { identity, port: parsed.port };
    if (!verifyPreviewToken(parsed.token, scope, options.key)) return null;
    return scope;
  }

  function forward(req: http.IncomingMessage, res: http.ServerResponse, target: PreviewTarget) {
    const upstream = http.request({
      host: upstreamHost(target.identity),
      port: target.port,
      method: req.method,
      path: req.url ?? "/",
      headers: forwardHeaders(req.headers),
      agent,
    });

    upstream.on("response", (response) => {
      res.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(res);
      response.on("error", (err) => {
        console.error(`[preview] upstream ${target.port} response failed:`, err);
        res.destroy();
      });
    });

    upstream.on("error", (err) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      // A stopped dev server is ordinary, so it is a page rather than a stack.
      if ((err as NodeJS.ErrnoException).code === "ECONNREFUSED") {
        sendPage(res, 502, unavailablePage(target.port));
        return;
      }
      console.warn(`[preview] ${target.identity}:${target.port} failed:`, err);
      sendPage(res, 502, unavailablePage(target.port));
    });

    res.on("close", () => upstream.destroy());
    req.pipe(upstream);
  }

  const server = http.createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if (path === PREVIEW_HEALTH_PATH) {
      const body = JSON.stringify({ ok: true });
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        "Cache-Control": "no-store",
      });
      res.end(body);
      return;
    }

    resolveTarget(req.headers.host)
      .then((target) => {
        if (!target) {
          sendPage(res, 404, NOT_FOUND_PAGE);
          return;
        }
        forward(req, res, target);
      })
      .catch((err: unknown) => {
        console.error("[preview] resolving a hostname failed:", err);
        sendPage(res, 404, NOT_FOUND_PAGE);
      });
  });

  // A websocket upgrade is a handshake this process relays byte for byte.
  server.on("upgrade", (req, socket, head) => {
    resolveTarget(req.headers.host)
      .catch((err: unknown) => {
        console.error("[preview] resolving an upgrade hostname failed:", err);
        return null;
      })
      .then((target) => {
        if (!target) {
          socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
          return;
        }
        relayUpgrade(req, socket, head, target);
      });
  });

  function relayUpgrade(
    req: http.IncomingMessage,
    socket: Duplex,
    head: Buffer,
    target: PreviewTarget,
  ): void {
    const upstream = net.connect({ host: upstreamHost(target.identity), port: target.port }, () => {
      const lines = [`${req.method ?? "GET"} ${req.url ?? "/"} HTTP/1.1`];
      for (let index = 0; index < req.rawHeaders.length; index += 2) {
        lines.push(`${req.rawHeaders[index]}: ${req.rawHeaders[index + 1]}`);
      }
      upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head.length > 0) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });

    upstream.on("error", (err) => {
      console.warn(`[preview] upgrade to ${target.identity}:${target.port} failed:`, err);
      socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
    });
    // Either end going away ends the pair. An HMR socket can live for hours, and
    // a closed tab must not leave the upstream half of it open.
    socket.on("close", () => upstream.destroy());
    upstream.on("close", () => socket.destroy());
    socket.on("error", (err) => {
      console.warn(`[preview] upgrade socket closed:`, err);
      upstream.destroy();
    });
  }

  server.requestTimeout = NO_TIMEOUT;
  server.timeout = NO_TIMEOUT;
  server.headersTimeout = 60_000;

  return server;
}
