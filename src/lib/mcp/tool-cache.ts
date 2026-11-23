/**
 * The tools a server last answered with, so the settings page can name them
 * without connecting again.
 *
 * A policy per MCP tool needs the tool names, and the names only exist in a
 * server's `tools/list` answer. The catalogue is a cache, not a record: a server
 * that has not been reached yet has none, and the settings page offers to look.
 */

import { createMcpToolName } from "@earendil-works/pi-mcp";

import type { McpToolSummary } from "@/lib/mcp/shared";
import { getRedis } from "@/lib/redis";

/** How long a catalogue is worth showing before it is looked up again. */
const TOOLS_TTL_SECONDS = 7 * 24 * 60 * 60;

function toolsKey(serverId: string): string {
  return `mcp-tools:${serverId}`;
}

/**
 * Remember a server's tool list from a successful connection.
 *
 * Names come from Pi's own helper, so a policy stored here is the name the
 * approval gate resolves. Two tools that sanitize to one name are told apart
 * the same way Pi does it.
 */
export async function cacheMcpTools(
  serverId: string,
  serverName: string,
  tools: readonly { name: string; description: string | null }[],
): Promise<void> {
  const taken = new Set<string>();
  const summary: McpToolSummary[] = tools.map((tool) => {
    const name = createMcpToolName(serverName, tool.name, (candidate) => taken.has(candidate));
    taken.add(name);
    return { name, label: tool.name, description: tool.description ?? null };
  });
  try {
    await getRedis().set(toolsKey(serverId), JSON.stringify(summary), "EX", TOOLS_TTL_SECONDS);
  } catch (err) {
    // The list only saves a connection; losing it costs a probe.
    console.error(`Failed to cache the tools of MCP server ${serverId}:`, err);
  }
}

/** The cached tool list of a server, or null when it has not been reached. */
export async function readCachedMcpTools(serverId: string): Promise<McpToolSummary[] | null> {
  try {
    const raw = await getRedis().get(toolsKey(serverId));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((entry): entry is McpToolSummary => {
      if (!entry || typeof entry !== "object") return false;
      const tool = entry as Partial<McpToolSummary>;
      return typeof tool.name === "string" && typeof tool.label === "string";
    });
  } catch (err) {
    console.error(`Failed to read the cached tools of MCP server ${serverId}:`, err);
    return null;
  }
}
