/**
 * Per-user Model Context Protocol servers.
 *
 * Saale keeps each user's servers in the database and hands them to Pi's MCP
 * extension, which connects them when an agent session starts. Two rules:
 *
 * - **Nothing runs on the app host.** A streamable HTTP server is connected from
 *   here; a stdio server's command runs in the owner's workspace container,
 *   through the same service the terminal tools use. Pi never spawns a tenant
 *   command itself, because that would run with the app's environment and
 *   privileges.
 * - **Config from the database, never from disk.** Pi's `mcp.json` lives in the
 *   host's Pi directory, which belongs to whoever installed Pi on the machine,
 *   not to a tenant (same reasoning as `lib/pi/settings.ts`).
 *
 * Configuration rules live in `shared.ts`; this module is the server side:
 * database access, token decryption, and the Pi extension.
 */

import fs from "fs/promises";
import path from "path";
import {
  createMcpExtension,
  type ExtensionFactory,
  type LoadedMcpConfig,
  type McpServerConfig,
  type McpServerEntry,
  type McpTransportFactory,
} from "@earendil-works/pi-coding-agent";
import { StreamableHttpTransport, type McpTransport } from "@earendil-works/pi-mcp";
import { decrypt } from "@/lib/crypto";
import { prisma } from "@/lib/db";
import { canExec } from "@/lib/sandbox/client";
import { mergeOwnedRows } from "@/lib/shared-resources";
import { getUploadsDir } from "@/lib/uploads";
import { createMcpAuthProvider, type McpOAuthServer } from "./oauth";
import {
  isMcpToolPolicy,
  isMcpTransport,
  mcpNameKey,
  type McpScope,
  type McpToolPolicy,
} from "./shared";
import { createWorkspaceMcpTransport } from "./stdio";
import {
  isCategoryEnabled,
  resolveCategoryExposure,
  type ToolConfig,
  type ToolExposure,
  type ToolExposureConfig,
} from "@/lib/pi/tool-categories";

/** The row shape the Pi-config builder needs. */
export interface McpServerRow {
  name: string;
  /** `http` or `stdio`; anything else is read as `http`. */
  transport: string;
  url: string | null;
  command: string | null;
  cwd: string | null;
  /** Variables for the command, as stored: name to ciphertext, in JSON. */
  env?: string | null;
  description: string;
  encryptedToken: string | null;
}

/**
 * Bearer token for a stored server, or null when it has none.
 *
 * A token that cannot be decrypted (for example after a key change) is logged
 * and treated as absent: the server stays configured and its connection test
 * explains the 401, instead of every session failing to build.
 */
export function readMcpToken(server: Pick<McpServerRow, "name" | "encryptedToken">): string | null {
  if (!server.encryptedToken) return null;
  try {
    return decrypt(server.encryptedToken);
  } catch (err) {
    console.error(`Failed to decrypt the MCP token for server "${server.name}":`, err);
    return null;
  }
}

/**
 * A command server's own variables, decrypted, or none.
 *
 * A value that cannot be decrypted is logged and skipped: one unreadable value
 * must not keep the server from starting. They never go into Pi's config `env`,
 * whose values are expanded for `${NAME}` and `!command`, so a token holding a
 * dollar sign would be rewritten and one holding a bang would run something.
 */
export function readMcpEnv(server: Pick<McpServerRow, "name" | "env">): Record<string, string> {
  if (!server.env) return {};
  try {
    const parsed: unknown = JSON.parse(server.env);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const env: Record<string, string> = {};
    for (const [name, stored] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof stored !== "string") continue;
      try {
        env[name] = decrypt(stored);
      } catch (err) {
        console.error(`Failed to decrypt ${name} for MCP server "${server.name}":`, err);
      }
    }
    return env;
  } catch (err) {
    console.error(`Failed to read the variables of MCP server "${server.name}":`, err);
    return {};
  }
}

/**
 * Pi's config for one stored server, at the exposure the user chose for the
 * `mcp` category. It starts at codemode: a server can bring hundreds of tools,
 * and a script reaches them without spending the prompt on each one.
 *
 * A stdio entry carries its command line; the transport factory in this module
 * is what runs it in the workspace, so Pi's own stdio spawner is never used.
 */
export function toMcpServerConfig(
  server: McpServerRow,
  exposure: ToolExposure = resolveCategoryExposure(null, "mcp"),
): McpServerConfig {
  if (isMcpTransport(server.transport) && server.transport === "stdio") {
    return {
      type: "stdio",
      command: server.command ?? "",
      ...(server.cwd ? { cwd: server.cwd } : {}),
      exposure,
      ...(server.description ? { description: server.description } : {}),
    };
  }

  const token = readMcpToken(server);
  return {
    type: "http",
    url: server.url ?? "",
    exposure,
    ...(server.description ? { description: server.description } : {}),
    ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
  };
}

export interface UserMcpServers {
  /** Servers Pi should connect, in creation order. */
  entries: McpServerEntry[];
  /** Approval policy per server, keyed by `mcpNameKey(name)`. */
  policies: Record<string, McpToolPolicy>;
  /** Server identity for OAuth, keyed by `mcpNameKey(name)`. */
  oauthServers: Map<string, McpOAuthServer>;
  /** A command server's own variables, keyed by `mcpNameKey(name)`. */
  commandEnv: Map<string, Record<string, string>>;
}

/** The session settings the `mcp` tool category is read from. */
export interface McpSessionSettings {
  /** The chat the servers connect in, so its eviction can end their commands. */
  sessionId?: string;
  /** Where the session runs. Only the servers switched on for it connect. */
  scope: McpScope;
  /** The session's tool config. The `mcp` category decides whether servers connect. */
  toolConfig?: ToolConfig | null | undefined;
  /** Per-category exposure (`AppSettings.toolExposure`). How the tools reach the model. */
  exposure?: ToolExposureConfig | null | undefined;
}

/**
 * The columns the extension needs from a row, whichever table it came from.
 * `userId` is null for an instance-owned server, which has no OAuth sign-in.
 */
interface McpConnectable extends McpServerRow {
  id: string;
  userId: string | null;
  toolPolicy: string;
}

/**
 * Load the enabled servers of one user, ready for the MCP extension.
 *
 * The set is the instance's shared servers plus the user's own. A user's server
 * wins a name clash: Pi folds `-` and `_` into one character, so two servers of
 * one key would contribute tool names nobody could tell apart.
 *
 * Nothing is loaded while the `mcp` category is off for the session: the switch
 * is what keeps a configured server out of a conversation. A server also only
 * connects in the scope it is switched on for.
 */
export async function loadUserMcpServers(
  userId: string,
  settings: McpSessionSettings,
): Promise<UserMcpServers> {
  if (!isCategoryEnabled(settings.toolConfig, "mcp")) {
    return { entries: [], policies: {}, oauthServers: new Map(), commandEnv: new Map() };
  }

  const exposure = resolveCategoryExposure(settings.exposure, "mcp");
  const scope = settings.scope === "chat" ? { chatEnabled: true } : { coderEnabled: true };
  const order = { orderBy: { createdAt: "asc" } } as const;
  const [ownRows, sharedRows] = await Promise.all([
    prisma.mcpServer.findMany({ where: { userId, enabled: true, ...scope }, ...order }),
    prisma.sharedMcpServer.findMany({ where: { enabled: true, ...scope }, ...order }),
  ]);

  const own: McpConnectable[] = ownRows;
  const shared: McpConnectable[] = sharedRows.map((row) => ({
    ...row,
    userId: null,
    // A shared server is always an HTTP endpoint.
    transport: "http",
    command: null,
    cwd: null,
  }));
  const merged = mergeOwnedRows({ own, shared, keyOf: (row) => mcpNameKey(row.name) });

  const entries: McpServerEntry[] = [];
  const policies: Record<string, McpToolPolicy> = {};
  const oauthServers = new Map<string, McpOAuthServer>();
  const commandEnv = new Map<string, Record<string, string>>();

  for (const { shared: isShared, ...server } of merged) {
    entries.push({
      name: server.name,
      config: toMcpServerConfig(server, exposure),
      source: isShared ? "Instance settings" : "Saale settings",
      scope: "extension",
    });
    const key = mcpNameKey(server.name);
    policies[key] = isMcpToolPolicy(server.toolPolicy) ? server.toolPolicy : "ask";
    const env = server.command && server.transport === "stdio" ? readMcpEnv(server) : {};
    if (Object.keys(env).length > 0) commandEnv.set(key, env);
    // OAuth is stored per account, and a command authenticates with the user's
    // own variables, so only an HTTP server of their own can sign in.
    if (server.userId !== null && server.url !== null) {
      oauthServers.set(key, {
        id: server.id,
        userId: server.userId,
        name: server.name,
        url: server.url,
      });
    }
  }

  return { entries, policies, oauthServers, commandEnv };
}

/** Where a user's MCP server log messages are appended. */
export async function getMcpLogPath(userId: string): Promise<string> {
  const dir = path.join(getUploadsDir(), "pi_sessions", userId);
  await fs.mkdir(dir, { recursive: true }).catch((err) => {
    console.error(`Failed to create the MCP log directory for user ${userId}:`, err);
  });
  return path.join(dir, "mcp.log");
}

/**
 * Transport for a user's server: streamable HTTP at its URL, or the command of a
 * stdio server in the user's workspace.
 *
 * The GET stream: Pi opens it by default to receive server-initiated
 * notifications. Pooled sessions are evicted with `session.dispose()`, which
 * does *not* emit `session_shutdown`. the MCP extension only closes its
 * connections there. so a session with the default transport would leave one
 * open stream per configured server behind for the life of the process. The
 * price is that a server whose tool list changes is only re-read on the next
 * connect (a config change already rebuilds the session).
 *
 * Auth: a server with a stored bearer token sends it, as before. A server
 * without one authenticates with OAuth through Saale's own provider, whose
 * credentials live in the database per user (`lib/mcp/oauth.ts`). never in
 * Pi's host-wide `mcp-auth.json`, which the operator's Pi CLI and every tenant
 * share. When no sign-in is stored, the provider raises
 * `McpOAuthAuthorizationRequiredError`, and the settings page offers the
 * browser sign-in that the agent session cannot perform.
 *
 * A stdio server's command goes through `sandbox-exec`, never `pipe`/`spawn`: the
 * program belongs in the tenant's container, with the tenant's variables, so Pi's
 * own stdio transport is not an option here.
 */
function createUserMcpTransport(
  userId: string,
  servers: Map<string, McpOAuthServer>,
  commandEnv: Map<string, Record<string, string>>,
  sessionId: string | undefined,
): McpTransportFactory {
  return (entry): McpTransport => {
    const config = entry.config;

    if (!("url" in config)) {
      if (!config.command.trim()) {
        throw new Error(`MCP server "${entry.name}" has no command`);
      }
      if (!canExec()) {
        throw new Error(
          `MCP server "${entry.name}" runs a command, and this deployment has no workspace service`,
        );
      }
      const env = commandEnv.get(mcpNameKey(entry.name));
      return createWorkspaceMcpTransport({
        userId,
        name: entry.name,
        command: config.command,
        cwd: config.cwd ?? null,
        ...(env ? { env } : {}),
        ...(sessionId ? { sessionId } : {}),
      });
    }

    const hasAuthorization = Object.keys(config.headers ?? {}).some(
      (header) => header.toLowerCase() === "authorization",
    );
    const oauthServer = hasAuthorization ? undefined : servers.get(mcpNameKey(entry.name));

    return new StreamableHttpTransport({
      url: config.url,
      ...(config.headers ? { headers: config.headers } : {}),
      ...(oauthServer ? { authProvider: createMcpAuthProvider(oauthServer) } : {}),
      openGetStream: false,
    });
  };
}

export interface UserMcpExtension {
  extension: ExtensionFactory;
  policies: Record<string, McpToolPolicy>;
}

/**
 * Build the MCP extension for one user, or null when they have no servers.
 *
 * The returned factory is handed to the session's resource loader, which
 * connects the snapshotted servers when the session starts. A configuration
 * change therefore needs the pooled session to be rebuilt (see
 * `evictUserSessions` in `lib/pi/agent-pool.ts`).
 */
export async function createUserMcpExtension(
  userId: string,
  settings: McpSessionSettings,
): Promise<UserMcpExtension | null> {
  const { entries, policies, oauthServers, commandEnv } = await loadUserMcpServers(
    userId,
    settings,
  );
  if (entries.length === 0) return null;

  const logPath = await getMcpLogPath(userId);

  const extension = createMcpExtension({
    // Pi asks the loader once, at session start.
    loadConfig: (): LoadedMcpConfig => ({ servers: entries, errors: [] }),
    createTransport: createUserMcpTransport(userId, oauthServers, commandEnv, settings.sessionId),
    logPath,
    // There is no `/mcp` overlay in a hosted app, so an OAuth sign-in is
    // completed from the settings page instead (lib/mcp/oauth.ts). Nothing
    // should reach this: a server that needs a sign-in fails the connection
    // with `McpOAuthAuthorizationRequiredError` rather than redirecting here.
    openUrl: (url) => {
      console.error(`MCP server requires an OAuth sign-in started from Saale settings: ${url}`);
    },
    // Servers live in the database. never write a host `mcp.json`.
    updateConfig: () => {
      console.error("MCP configuration is managed by Saale settings, not by the agent session");
    },
  });

  return { extension, policies };
}
