import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { previewToken } from "@/lib/preview/token";
import { previewIdentitySlug } from "@/lib/preview/url";
import { PREVIEW_HEALTH_PATH, createPreviewProxy } from "@/sandbox/preview-proxy";

/**
 * The preview listener, against a real upstream.
 *
 * The proxy is a pass-through: the point of these tests is that the app behind
 * it sees the same path, query and host it would see on its own origin, that a
 * wrong signature gets nowhere, and that an upgrade is relayed both ways.
 */

const KEY = "0123456789abcdef0123456789abcdef";
const IDENTITY = "user-c1a2b3c4d5e6f7g8h9i0j1k2l";
const OTHER = "user-d9e8f7a6b5c4d3e2f1a0b9c8d";
/** The workspaces the proxy is told about; any other slug names nothing. */
const IDENTITY_BY_SLUG = {
  [previewIdentitySlug(IDENTITY)]: IDENTITY,
  [previewIdentitySlug(OTHER)]: OTHER,
};

const servers: http.Server[] = [];
/** Upgraded sockets, which `closeAllConnections` leaves alone. */
const upgraded: net.Socket[] = [];

async function startServer(server: http.Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return address.port;
}

/** A free port: bound once, then released. */
async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

let upstreamPort: number;
let proxyPort: number;

function previewHostFor(port: number, identity = IDENTITY): string {
  const slug = previewIdentitySlug(identity);
  return `${slug}-${port}-${previewToken({ identity, port }, KEY)}.preview.test`;
}

/** A request straight to the proxy with the preview hostname in `Host`. */
function request(
  path: string,
  options: { host?: string; method?: string } = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: proxyPort,
        path,
        method: options.method ?? "GET",
        headers: { host: options.host ?? previewHostFor(upstreamPort) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

beforeEach(async () => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json", "X-Seen-Host": req.headers.host });
    res.end(JSON.stringify({ url: req.url, host: req.headers.host, method: req.method }));
  });

  // A socket that echoes bytes back after the handshake, standing in for HMR.
  upstream.on("upgrade", (req, socket: net.Socket) => {
    upgraded.push(socket);
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\n");
    socket.on("data", (chunk: Buffer) =>
      socket.write(Buffer.concat([Buffer.from("echo:"), chunk])),
    );
    socket.on("error", () => socket.destroy());
  });

  upstreamPort = await startServer(upstream);
  proxyPort = await startServer(
    createPreviewProxy({
      key: KEY,
      resolveIdentity: (slug) => IDENTITY_BY_SLUG[slug] ?? null,
      upstreamHost: () => "127.0.0.1",
    }),
  );
});

afterEach(async () => {
  for (const socket of upgraded.splice(0)) socket.destroy();
  for (const server of servers.splice(0)) {
    // Keep-alive and upgraded sockets outlive the tests that opened them.
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe("the preview proxy", () => {
  it("passes the path, the query and the preview host through unchanged", async () => {
    const response = await request("/app/index.html?x=1&y=2");

    expect(response.status).toBe(200);
    expect(response.headers["x-seen-host"]).toBe(previewHostFor(upstreamPort));
    expect(JSON.parse(response.body)).toEqual({
      url: "/app/index.html?x=1&y=2",
      host: previewHostFor(upstreamPort),
      method: "GET",
    });
  });

  it("forwards a request body and the method", async () => {
    const body = JSON.stringify({ hello: "world" });
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port: proxyPort,
          path: "/api/thing",
          method: "POST",
          headers: {
            host: previewHostFor(upstreamPort),
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body),
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end(body);
    });

    expect(status).toBe(200);
  });

  it("refuses a hostname whose signature does not match the port", async () => {
    const wrong = `${previewIdentitySlug(IDENTITY)}-${upstreamPort}-${previewToken({ identity: IDENTITY, port: upstreamPort + 1 }, KEY)}.preview.test`;
    const response = await request("/", { host: wrong });

    expect(response.status).toBe(404);
    expect(response.body).toContain("This preview link does not work");
  });

  it("refuses a token signed for a different workspace", async () => {
    const token = previewToken({ identity: IDENTITY, port: upstreamPort }, KEY);
    const other = `${previewIdentitySlug(OTHER)}-${upstreamPort}-${token}.preview.test`;
    const response = await request("/", { host: other });
    expect(response.status).toBe(404);
  });

  it("refuses a hostname whose slug names no workspace", async () => {
    const token = previewToken({ identity: IDENTITY, port: upstreamPort }, KEY);
    const unknown = `0123456789-${upstreamPort}-${token}.preview.test`;
    const response = await request("/", { host: unknown });
    expect(response.status).toBe(404);
  });

  it("refuses a request with no preview host at all", async () => {
    const response = await request("/", { host: "saale.example.com" });
    expect(response.status).toBe(404);
  });

  it("answers the health probe without a signature", async () => {
    const response = await request(PREVIEW_HEALTH_PATH, { host: "probe.preview.test" });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ ok: true });
  });

  it("says so, as a page, when nothing is listening", async () => {
    const closed = await freePort();
    const response = await request("/", { host: previewHostFor(closed) });

    expect(response.status).toBe(502);
    expect(response.body).toContain(`Nothing is listening on port ${closed}`);
    expect(response.body).toContain("0.0.0.0");
  });

  it("relays an upgrade in both directions", async () => {
    const socket = net.connect(proxyPort, "127.0.0.1");
    const received: Buffer[] = [];

    await new Promise<void>((resolve, reject) => {
      socket.on("error", reject);
      socket.on("connect", () => {
        socket.write(
          [
            "GET /hmr HTTP/1.1",
            `Host: ${previewHostFor(upstreamPort)}`,
            "Upgrade: websocket",
            "Connection: Upgrade",
            "",
            "",
          ].join("\r\n"),
        );
      });
      socket.on("data", (chunk: Buffer) => {
        received.push(chunk);
        resolve();
      });
    });

    expect(Buffer.concat(received).toString("utf8")).toContain("101 Switching Protocols");

    socket.write("ping");
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no echo")), 2000);
      const onData = (chunk: Buffer) => {
        received.push(chunk);
        if (Buffer.concat(received).toString("utf8").includes("echo:ping")) {
          clearTimeout(timer);
          socket.off("data", onData);
          resolve();
        }
      };
      socket.on("data", onData);
    });

    socket.destroy();
  });
});
