/**
 * The settings page's "Test" button.
 *
 * It performs the same streamable-HTTP handshake Pi does, so a server that the
 * test accepts works in a chat — and a rejected one explains itself instead of
 * failing silently later.
 */

import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import { describeProbeError, probeMcpServer } from "@/lib/mcp/probe";

interface FakeServer {
  url: string;
  requests: { method: string; authorization: string | null }[];
  close: () => Promise<void>;
}

/** Minimal streamable-HTTP MCP server: JSON responses, no server-to-client stream. */
async function startFakeMcpServer(
  options: { requireToken?: string; tools?: { name: string; description: string }[] } = {},
): Promise<FakeServer> {
  const requests: FakeServer["requests"] = [];

  const server = http.createServer((req, res) => {
    const authorization = req.headers.authorization ?? null;
    requests.push({ method: req.method ?? "", authorization });

    if (options.requireToken && authorization !== `Bearer ${options.requireToken}`) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }

    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const message = JSON.parse(body || "{}") as {
        id?: unknown;
        method?: string;
        params?: unknown;
      };
      const respond = (result: unknown) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
      };

      switch (message.method) {
        case "initialize":
          respond({
            protocolVersion: (message.params as { protocolVersion?: string } | undefined)
              ?.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "fake-home-assistant", version: "2.1.0" },
            instructions: "Controls the house.",
          });
          return;
        case "tools/list":
          respond({
            tools: (
              options.tools ?? [{ name: "HassTurnOn", description: "Turn something on" }]
            ).map((tool) => ({
              name: tool.name,
              description: tool.description,
              inputSchema: { type: "object", properties: {} },
            })),
          });
          return;
        default:
          res.writeHead(202);
          res.end();
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fake server has no port");

  return {
    url: `http://127.0.0.1:${address.port}/api/mcp`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

describe("probeMcpServer", () => {
  let fake: FakeServer | null = null;

  afterEach(async () => {
    await fake?.close();
    fake = null;
  });

  it("performs the handshake and reports the tools", async () => {
    fake = await startFakeMcpServer({
      tools: [
        { name: "HassTurnOn", description: "Turn something on" },
        { name: "HassLightSet", description: "Set a light" },
      ],
    });

    const result = await probeMcpServer({ url: fake.url });

    expect(result.serverName).toBe("fake-home-assistant");
    expect(result.serverVersion).toBe("2.1.0");
    expect(result.instructions).toBe("Controls the house.");
    expect(result.tools).toEqual([
      { name: "HassTurnOn", description: "Turn something on" },
      { name: "HassLightSet", description: "Set a light" },
    ]);
  });

  it("sends the stored token as a bearer header", async () => {
    fake = await startFakeMcpServer({ requireToken: "ha-token" });

    const result = await probeMcpServer({ url: fake.url, token: "ha-token" });

    expect(result.serverName).toBe("fake-home-assistant");
    expect(fake.requests.every((request) => request.authorization === "Bearer ha-token")).toBe(
      true,
    );
  });

  it("fails with a readable error when the token is rejected", async () => {
    fake = await startFakeMcpServer({ requireToken: "right-token" });

    await expect(probeMcpServer({ url: fake.url, token: "wrong-token" })).rejects.toThrow();
    await probeMcpServer({ url: fake.url, token: "wrong-token" }).catch((err) => {
      expect(describeProbeError(err)).toContain("401");
    });
  });

  it("fails when nothing is listening", async () => {
    await expect(probeMcpServer({ url: "http://127.0.0.1:1/api/mcp" })).rejects.toThrow();
  });
});

describe("describeProbeError", () => {
  it("includes the HTTP status an MCP client reports", () => {
    const error = Object.assign(new Error("MCP server returned 401"), { status: 401 });
    expect(describeProbeError(error)).toBe("MCP server returned 401 (HTTP 401)");
  });

  it("falls back to the message, and to a string for non-errors", () => {
    expect(describeProbeError(new Error("connect ECONNREFUSED"))).toBe("connect ECONNREFUSED");
    expect(describeProbeError("boom")).toBe("boom");
  });
});
