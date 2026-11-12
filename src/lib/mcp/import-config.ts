/**
 * A server list pasted from another MCP client.
 *
 * Every client in the ecosystem writes the same shape — `command`, `args`,
 * `env`, `cwd` for a command, `url` and `headers` for an endpoint — so a config
 * can be carried over as it is. This module reads that text and nothing else: no
 * database, no crypto, so the parser can be tested against the configs people
 * actually paste.
 */

import { normalizeMcpServerName, validateMcpServerName } from "./shared";

/** One server read out of a pasted config. */
export interface ImportedMcpServer {
  name: string;
  transport: "stdio" | "http";
  url: string | null;
  command: string | null;
  cwd: string | null;
  env: Record<string, string>;
  /** A bearer token read from the config's `Authorization` header. */
  token: string | null;
  description: string;
}

/** An entry the parser read but could not turn into a server, and why. */
export interface SkippedMcpServer {
  name: string;
  error: string;
}

export interface McpConfigImport {
  servers: ImportedMcpServer[];
  skipped: SkippedMcpServer[];
}

export type McpConfigParse = { ok: true; value: McpConfigImport } | { ok: false; error: string };

/** Longest config a paste may carry: a handful of servers, not an archive. */
export const MCP_IMPORT_MAX_CHARS = 64 * 1024;

/** The keys a config may carry around the servers themselves. */
const CONTAINER_KEYS = ["mcpServers", "servers", "context_servers"] as const;

/**
 * Read a pasted config.
 *
 * Accepts what the clients write — `{ "mcpServers": { … } }`, `{ "servers": … }`,
 * a single server object, or a list of them — and reports per entry what it
 * could not use, so one bad line does not throw away the rest.
 */
export function parseMcpConfig(text: string): McpConfigParse {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: "Paste a server config first." };
  if (trimmed.length > MCP_IMPORT_MAX_CHARS) {
    return { ok: false, error: "That config is too large to import at once." };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    return { ok: false, error: `That is not valid JSON: ${(err as Error).message}` };
  }

  const importable = readServers(parsed);
  if (!importable) {
    return {
      ok: false,
      error:
        'Expected {"mcpServers": {"name": {...}}} or a list of servers with a command or a URL.',
    };
  }

  const servers: ImportedMcpServer[] = [];
  const skipped: SkippedMcpServer[] = [];
  const seen = new Set<string>();

  for (const entry of importable) {
    const result = readServer(entry.name, entry.config);
    if (!result.ok) {
      skipped.push({ name: entry.name, error: result.error });
      continue;
    }
    // Two entries of one name would fight over the same tool namespace.
    if (seen.has(result.value.name)) {
      skipped.push({ name: entry.name, error: "Another entry in this config has the same name." });
      continue;
    }
    seen.add(result.value.name);
    servers.push(result.value);
  }

  if (servers.length === 0 && skipped.length === 0) {
    return { ok: false, error: "That config holds no servers." };
  }
  return { ok: true, value: { servers, skipped } };
}

interface NamedEntry {
  name: string;
  config: unknown;
}

/** The entries a parsed config holds, or null when it is not a config at all. */
function readServers(parsed: unknown): NamedEntry[] | null {
  if (Array.isArray(parsed)) {
    return parsed.flatMap((entry) =>
      entry && typeof entry === "object"
        ? [
            {
              name:
                typeof (entry as { name?: unknown }).name === "string"
                  ? (entry as { name: string }).name
                  : "",
              config: entry,
            },
          ]
        : [],
    );
  }
  if (!parsed || typeof parsed !== "object") return null;

  const object = parsed as Record<string, unknown>;
  for (const key of CONTAINER_KEYS) {
    const container = object[key];
    if (container && typeof container === "object" && !Array.isArray(container)) {
      return Object.entries(container as Record<string, unknown>).map(([name, config]) => ({
        name,
        config,
      }));
    }
  }

  // A single server, which carries its own name or none.
  if ("command" in object || "url" in object) {
    const name = typeof object.name === "string" ? object.name : "";
    return [{ name, config: object }];
  }
  return null;
}

function readServer(
  rawName: string,
  config: unknown,
): { ok: true; value: ImportedMcpServer } | { ok: false; error: string } {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return { ok: false, error: "This entry is not a server." };
  }
  const entry = config as Record<string, unknown>;
  const name = normalizeMcpServerName(rawName);
  const nameError = validateMcpServerName(name);
  if (nameError) return { ok: false, error: nameError };

  const parsedEnv = readEnv(entry.env);
  const description = typeof entry.description === "string" ? entry.description.trim() : "";
  const cwd = typeof entry.cwd === "string" ? entry.cwd.trim() : "";

  const url = typeof entry.url === "string" ? entry.url.trim() : "";
  if (url) {
    if (entry.type === "sse") {
      return { ok: false, error: "An SSE endpoint is not supported; use a streamable HTTP URL." };
    }
    return {
      ok: true,
      value: {
        name,
        transport: "http",
        url,
        command: null,
        cwd: null,
        env: {},
        token: readBearerToken(entry.headers),
        description,
      },
    };
  }

  const command = typeof entry.command === "string" ? entry.command.trim() : "";
  if (!command) {
    return { ok: false, error: "This entry has neither a command nor a URL." };
  }

  return {
    ok: true,
    value: {
      name,
      transport: "stdio",
      url: null,
      command: commandLine(command, entry.args),
      cwd: cwd || null,
      env: parsedEnv,
      token: null,
      description,
    },
  };
}

/** `command` and `args`, as the shell line the settings store keeps. */
function commandLine(command: string, args: unknown): string {
  if (!Array.isArray(args) || args.length === 0) return command;
  return [command, ...args.map((arg) => quoteShellArg(String(arg)))].join(" ");
}

/**
 * One argument, quoted for the shell the command runs under.
 *
 * Another client's config passes arguments as a list, so nothing in them was
 * ever meant to be split or expanded: a path with a space, or a token with a
 * dollar sign, has to arrive as it was written.
 */
export function quoteShellArg(arg: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** The variables of an entry; a number or a boolean is taken as its text. */
function readEnv(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string") env[name] = value;
    else if (typeof value === "number" || typeof value === "boolean") env[name] = String(value);
  }
  return env;
}

/** The bearer token an endpoint's config carries, if any. */
function readBearerToken(headers: unknown): string | null {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) return null;
  for (const [header, value] of Object.entries(headers as Record<string, unknown>)) {
    if (header.toLowerCase() !== "authorization" || typeof value !== "string") continue;
    const match = /^bearer\s+(.+)$/i.exec(value.trim());
    if (match?.[1]) return match[1].trim();
  }
  return null;
}
