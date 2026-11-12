/**
 * MCP configuration rules shared by the API routes, the settings UI and the
 * Pi wiring in `servers.ts`.
 *
 * Kept free of server-only imports (database, crypto, Pi) so client components
 * can use the types, the validation, and the name handling without pulling a
 * server module into the browser bundle.
 */

import { envNameError, envValueBytes, envValueError } from "@/lib/sandbox/env-rules";

/** How a user's MCP tool calls are handled when they have no per-tool policy. */
export const MCP_TOOL_POLICIES = ["ask", "allow", "off"] as const;
export type McpToolPolicy = (typeof MCP_TOOL_POLICIES)[number];

/**
 * The two kinds of agent session a server can connect in.
 *
 * A coder chat works in a worktree and reaches for different things than a
 * conversation, so a user can keep one server for coding and another for chat.
 */
export const MCP_SCOPES = ["chat", "coder"] as const;
export type McpScope = (typeof MCP_SCOPES)[number];

/**
 * How Saale reaches a server: over HTTP at a URL, or by running a command in
 * the owner's workspace container.
 */
export const MCP_TRANSPORTS = ["http", "stdio"] as const;
export type McpTransport = (typeof MCP_TRANSPORTS)[number];

export function isMcpToolPolicy(value: unknown): value is McpToolPolicy {
  return typeof value === "string" && (MCP_TOOL_POLICIES as readonly string[]).includes(value);
}

export function isMcpTransport(value: unknown): value is McpTransport {
  return typeof value === "string" && (MCP_TRANSPORTS as readonly string[]).includes(value);
}

/** Longest command line a server may carry: a command, not a script. */
export const MCP_COMMAND_MAX = 1024;

/** Longest working directory, counted in the same characters the field shows. */
export const MCP_CWD_MAX = 256;

/** Variables one command may carry. */
export const MCP_ENV_MAX_VARS = 32;

/** Longest single value, in plaintext bytes. */
export const MCP_ENV_VALUE_MAX_BYTES = 8 * 1024;

/** Total plaintext bytes across one server's variables. */
export const MCP_ENV_TOTAL_MAX_BYTES = 32 * 1024;

/** A command's variables: name to value, as the user typed them. */
export type McpEnv = Record<string, string>;

/**
 * The variables a command starts with, or why they cannot be stored.
 *
 * They are kept apart from the account's own set so two servers can hold two
 * keys, and so a key for one server is not readable by every command in the
 * workspace. The command sees both, this set over the account's.
 */
export function parseMcpEnv(
  input: unknown,
): { ok: true; value: McpEnv } | { ok: false; error: string } {
  if (input === undefined || input === null) return { ok: true, value: {} };
  if (typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "Variables are a name and a value per entry." };
  }

  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length > MCP_ENV_MAX_VARS) {
    return { ok: false, error: `A server can carry at most ${MCP_ENV_MAX_VARS} variables.` };
  }

  const value: McpEnv = {};
  let total = 0;
  for (const [name, raw] of entries) {
    const nameError = envNameError(name);
    if (nameError) return { ok: false, error: nameError };
    // A JSON config from another client may hold a number or a boolean: the
    // container passes strings, so the text of it is what the command receives.
    const text =
      typeof raw === "string"
        ? raw
        : typeof raw === "number" || typeof raw === "boolean"
          ? String(raw)
          : null;
    if (text === null) return { ok: false, error: `The value of ${name} must be text.` };
    const valueError = envValueError(text, MCP_ENV_VALUE_MAX_BYTES);
    if (valueError) return { ok: false, error: valueError };
    total += envValueBytes(text);
    if (total > MCP_ENV_TOTAL_MAX_BYTES) {
      return {
        ok: false,
        error: `The variables of one server cannot exceed ${MCP_ENV_TOTAL_MAX_BYTES} bytes.`,
      };
    }
    value[name] = text;
  }
  return { ok: true, value };
}

/** The names a patch removes, or why the list cannot be used. */
export function parseMcpEnvRemove(
  input: unknown,
): { ok: true; value: string[] } | { ok: false; error: string } {
  if (input === undefined || input === null) return { ok: true, value: [] };
  if (!Array.isArray(input)) return { ok: false, error: "Give the variables to remove as a list." };

  const names: string[] = [];
  for (const name of input) {
    const nameError = envNameError(name);
    if (nameError) return { ok: false, error: nameError };
    names.push(name as string);
  }
  return { ok: true, value: names };
}

/** The names stored in a server's `env` column, for the settings sheet. */
export function mcpEnvNames(envJson: string | null): string[] {
  if (!envJson) return [];
  try {
    const parsed: unknown = JSON.parse(envJson);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    return Object.keys(parsed as Record<string, unknown>).sort();
  } catch {
    return [];
  }
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

/**
 * A stdio server's command line, as bash would run it in the workspace.
 *
 * Saale does not parse it: the sandbox hands the string to bash, so quotes,
 * pipes and `&&` mean what they mean in a terminal. Only a NUL byte is refused,
 * because it truncates the string at a syscall.
 */
export function validateMcpCommand(command: string): string | null {
  if (!command.trim()) return "Enter the command that starts the server.";
  if (command.includes("\0")) return "A command cannot contain a NUL byte.";
  if (command.length > MCP_COMMAND_MAX) {
    return `A command can be at most ${MCP_COMMAND_MAX} characters.`;
  }
  return null;
}

/**
 * A working directory for the command, relative to the workspace root.
 *
 * Absolute paths are refused rather than resolved: the workspace root is the
 * container's `HOME`, and a path above it is another identity's files.
 */
export function validateMcpCwd(cwd: string): string | null {
  if (!cwd) return null;
  if (cwd.length > MCP_CWD_MAX)
    return `A working directory can be at most ${MCP_CWD_MAX} characters.`;
  if (cwd.includes("\0")) return "A working directory cannot contain a NUL byte.";
  if (cwd.startsWith("/") || cwd.startsWith("~")) {
    return "Use a path inside your workspace, for example docs or projects/site.";
  }
  // The service confines the path too; this refuses it before it is stored.
  if (cwd.split(/[/\\]/).includes("..")) {
    return "A working directory cannot lead outside your workspace.";
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
  /** `http` for a URL, `stdio` for a command in the owner's workspace. */
  transport: McpTransport;
  /** The endpoint of an http server; null for a command server. */
  url: string | null;
  /** The command line of a stdio server; null for an http server. */
  command: string | null;
  /** Workspace-relative working directory of the command, or null for the root. */
  cwd: string | null;
  /** Names of the variables the command starts with. Values stay on the server. */
  envNames: string[];
  description: string;
  toolPolicy: McpToolPolicy;
  enabled: boolean;
  /** Whether the server connects in a chat. */
  chatEnabled: boolean;
  /** Whether the server connects in a coder chat. */
  coderEnabled: boolean;
  hasToken: boolean;
  /** Whether an OAuth credential is stored for this server. */
  hasOAuth: boolean;
  /** Written by an admin for the whole instance, so the user cannot edit it. */
  shared: boolean;
  createdAt: string;
  updatedAt: string;
}

export function toMcpServerView(
  server: {
    id: string;
    name: string;
    transport: string;
    url: string | null;
    command: string | null;
    cwd: string | null;
    env?: string | null;
    description: string;
    encryptedToken: string | null;
    toolPolicy: string;
    enabled: boolean;
    chatEnabled: boolean;
    coderEnabled: boolean;
    createdAt: Date;
    updatedAt: Date;
  },
  options: { hasOAuth?: boolean; shared?: boolean } = {},
): McpServerView {
  return {
    id: server.id,
    name: server.name,
    transport: isMcpTransport(server.transport) ? server.transport : "http",
    url: server.url,
    command: server.command,
    cwd: server.cwd,
    envNames: mcpEnvNames(server.env ?? null),
    description: server.description,
    toolPolicy: isMcpToolPolicy(server.toolPolicy) ? server.toolPolicy : "ask",
    enabled: server.enabled,
    chatEnabled: server.chatEnabled,
    coderEnabled: server.coderEnabled,
    hasToken: server.encryptedToken !== null,
    hasOAuth: options.hasOAuth ?? false,
    shared: options.shared ?? false,
    createdAt: server.createdAt.toISOString(),
    updatedAt: server.updatedAt.toISOString(),
  };
}
