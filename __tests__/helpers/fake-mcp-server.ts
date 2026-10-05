/**
 * A minimal streamable-HTTP MCP server for tests.
 *
 * Answers the handshake (`initialize`, `tools/list`) with JSON-RPC over plain
 * JSON — what Pi's MCP client and the settings connection test both speak — so
 * a test can exercise the real network path without an external server.
 */

import http from "node:http";

export interface FakeMcpTool {
  name: string;
  description: string;
}

export interface FakeMcpServer {
  url: string;
  /** Every request the server received, for asserting headers and method use. */
  requests: { method: string; authorization: string | null }[];
  /** Requests for the server-to-client stream (`GET`), which Saale never opens. */
  streamRequests: number;
  close: () => Promise<void>;
}

export interface FakeMcpServerOptions {
  /** When set, requests without this bearer token get a 401. */
  requireToken?: string;
  tools?: FakeMcpTool[];
  serverName?: string;
  serverVersion?: string;
  instructions?: string;
}

export async function startFakeMcpServer(
  options: FakeMcpServerOptions = {},
): Promise<FakeMcpServer> {
  const requests: FakeMcpServer["requests"] = [];
  const tools = options.tools ?? [{ name: "HassTurnOn", description: "Turn something on" }];

  let streamRequests = 0;

  const server = http.createServer((req, res) => {
    const authorization = req.headers.authorization ?? null;
    requests.push({ method: req.method ?? "", authorization });
    if (req.method === "GET") streamRequests++;

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
            serverInfo: {
              name: options.serverName ?? "fake-home-assistant",
              version: options.serverVersion ?? "2.1.0",
            },
            ...(options.instructions ? { instructions: options.instructions } : {}),
          });
          return;
        case "tools/list":
          respond({
            tools: tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              inputSchema: { type: "object", properties: {} },
            })),
          });
          return;
        case "tools/call":
          respond({ content: [{ type: "text", text: `called ${String(message.params)}` }] });
          return;
        default:
          res.writeHead(202);
          res.end();
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fake MCP server has no port");

  return {
    url: `http://127.0.0.1:${address.port}/api/mcp`,
    requests,
    get streamRequests() {
      return streamRequests;
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}
