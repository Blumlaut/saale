/**
 * Connection check for a configured MCP server.
 *
 * The settings page uses this to answer "does it work?" before the user relies
 * on it in a chat: it performs the same streamable HTTP handshake Pi does and
 * reports the tools the server offers.
 */

import { McpAuthRequiredError, McpClient, StreamableHttpTransport } from "@earendil-works/pi-mcp";

/** Handshake and tool listing must not hang a settings request. */
const PROBE_TIMEOUT_MS = 15_000;

/** What a successful probe reports about the server. */
export interface McpProbeResult {
  serverName: string | null;
  serverVersion: string | null;
  instructions: string | null;
  tools: { name: string; description: string | null }[];
}

/** Saale's client identity during the MCP handshake. */
const CLIENT_INFO = { name: "saale", version: "1" };

/** One-line, printable message for a failed probe (invalid URL, auth, transport). */
export function describeProbeError(err: unknown): string {
  if (err instanceof Error) {
    // The MCP client wraps HTTP failures; the status is the actionable part.
    const status = (err as { status?: unknown }).status;
    if (typeof status === "number") {
      const message = `${err.message} (HTTP ${status})`;
      return isOAuthChallenge(err)
        ? `${message}. This server asks clients to sign in with OAuth, which Saale does not support: use an access token instead.`
        : message;
    }
    return err.message;
  }
  return String(err);
}

/**
 * Whether a 401 points at OAuth rather than a bad token: an RFC 9728 bearer
 * challenge advertising the resource's metadata. Such a server has no token to
 * mistype, so "check your token" would send the user the wrong way.
 */
function isOAuthChallenge(err: Error): boolean {
  return (
    err instanceof McpAuthRequiredError &&
    /bearer/i.test(err.wwwAuthenticate ?? "") &&
    /resource_metadata=/i.test(err.wwwAuthenticate ?? "")
  );
}

/**
 * Connect to an MCP server and list what it offers.
 * Throws when the server cannot be reached, rejects the credentials, or
 * requires an OAuth sign-in Saale cannot perform.
 */
export async function probeMcpServer(options: {
  url: string;
  token?: string | null;
}): Promise<McpProbeResult> {
  const client = new McpClient({ ...CLIENT_INFO, requestTimeoutMs: PROBE_TIMEOUT_MS });
  const transport = new StreamableHttpTransport({
    url: options.url,
    ...(options.token ? { headers: { Authorization: `Bearer ${options.token}` } } : {}),
    // No long-lived server-to-client stream for a one-shot check, and no
    // retries: a probe either works now or reports why it did not.
    openGetStream: false,
    reconnect: { maxRetries: 0 },
  });

  try {
    await client.connect(transport);
    const tools = await client.listTools();

    return {
      serverName: client.serverInfo?.name ?? null,
      serverVersion: client.serverInfo?.version ?? null,
      instructions: client.instructions ?? null,
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description ?? null,
      })),
    };
  } finally {
    await client.close().catch((err) => {
      console.error("Failed to close the MCP probe connection:", err);
    });
  }
}
