/**
 * MCP configuration rules shared by the API routes, the settings UI and the
 * Pi wiring in `servers.ts`.
 *
 * Kept free of server-only imports (database, crypto, Pi) so client components
 * can use the types, the validation, and the name handling without pulling a
 * server module into the browser bundle.
 */

/** How a user's MCP tool calls are handled when they have no per-tool policy. */
export const MCP_TOOL_POLICIES = ["ask", "allow", "off"] as const;
export type McpToolPolicy = (typeof MCP_TOOL_POLICIES)[number];

export function isMcpToolPolicy(value: unknown): value is McpToolPolicy {
  return typeof value === "string" && (MCP_TOOL_POLICIES as readonly string[]).includes(value);
}

/** Prefix Pi gives every MCP tool: `mcp__<server>__<tool>`. */
export const MCP_TOOL_PREFIX = "mcp__";

/** Longest server name Pi accepts; every tool name it contributes embeds it. */
const SERVER_NAME_MAX = 64;

/**
 * Server names Pi accepts. Tool names are built from them, so anything else
 * would be rewritten into tool names the user cannot predict. Two separators in
 * a row are out too: `mcp__<server>__<tool>` cannot be split back for a server
 * named `home__assistant`.
 */
const SERVER_NAME_PATTERN = /^(?!.*[-_]{2})[A-Za-z0-9_-]{1,64}$/;

/**
 * Fold what the user typed into a name Pi can use, instead of refusing it.
 *
 * A server name is a segment of every tool name the server contributes, which
 * providers restrict to letters, digits, dashes and underscores. so the name
 * "HA Admin" becomes `ha_admin`. Separator runs collapse (Pi treats `-` and `_`
 * as the same character) and anything else becomes an underscore.
 */
export function normalizeMcpServerName(input: string): string {
  const folded = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/[-_]{2,}/g, "_")
    .replace(/^[-_]+|[-_]+$/g, "");
  // Cutting to length can leave the name ending on a separator.
  return folded.slice(0, SERVER_NAME_MAX).replace(/[-_]+$/, "");
}

/**
 * Pi treats `-` and `_` as the same character in server and tool names, so
 * `home-assistant` and `home_assistant` are one server.
 */
export function mcpNameKey(name: string): string {
  return name.toLowerCase().replace(/-/g, "_");
}

/** The server segment of an MCP tool name, normalized; null when it is not one. */
export function mcpServerFromToolName(toolName: string): string | null {
  if (!toolName.startsWith(MCP_TOOL_PREFIX)) return null;
  const rest = toolName.slice(MCP_TOOL_PREFIX.length);
  const end = rest.indexOf("__");
  if (end <= 0) return null;
  return rest.slice(0, end);
}

/** Validation messages are user-facing: return an error string, or null when valid. */
export function validateMcpServerName(name: string): string | null {
  if (name.length === 0) return "Give this server a name.";
  if (!SERVER_NAME_PATTERN.test(name)) {
    return "Use letters, digits, dashes and underscores (max 64 characters).";
  }
  return null;
}

export function validateMcpUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "Enter a valid URL, for example https://homeassistant.local:8123/api/mcp";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "The MCP endpoint must be an http(s) URL.";
  }
  return null;
}

/** The shape the settings UI receives; the token itself never leaves the server. */
export interface McpServerView {
  id: string;
  name: string;
  url: string;
  description: string;
  toolPolicy: McpToolPolicy;
  enabled: boolean;
  hasToken: boolean;
  /** Whether an OAuth credential is stored for this server. */
  hasOAuth: boolean;
  createdAt: string;
  updatedAt: string;
}

export function toMcpServerView(
  server: {
    id: string;
    name: string;
    url: string;
    description: string;
    encryptedToken: string | null;
    toolPolicy: string;
    enabled: boolean;
    createdAt: Date;
    updatedAt: Date;
  },
  hasOAuth = false,
): McpServerView {
  return {
    id: server.id,
    name: server.name,
    url: server.url,
    description: server.description,
    toolPolicy: isMcpToolPolicy(server.toolPolicy) ? server.toolPolicy : "ask",
    enabled: server.enabled,
    hasToken: server.encryptedToken !== null,
    hasOAuth,
    createdAt: server.createdAt.toISOString(),
    updatedAt: server.updatedAt.toISOString(),
  };
}
