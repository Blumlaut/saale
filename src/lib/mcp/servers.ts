/**
 * Per-user Model Context Protocol servers.
 *
 * Saale keeps each user's servers in the database and hands them to Pi's MCP
 * extension, which connects them when an agent session starts. Two deliberate
 * restrictions:
 *
 * - **Streamable HTTP only.** A stdio server is a command Pi spawns in *this*
 *   process, so a user-configured command would run with the Saale server's
 *   environment and privileges. Everything Saale executes on a user's behalf
 *   goes through Open Terminal (the sandboxed workspace), never the app host.
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
import { StreamableHttpTransport } from "@earendil-works/pi-mcp";
import { decrypt } from "@/lib/crypto";
import { prisma } from "@/lib/db";
import { getUploadsDir } from "@/lib/uploads";
import { createMcpAuthProvider, type McpOAuthServer } from "./oauth";
import { isMcpToolPolicy, mcpNameKey, type McpToolPolicy } from "./shared";

/** The row shape the Pi-config builder needs. */
export interface McpServerRow {
  name: string;
  url: string;
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
 * Pi's config for one stored server. Tools stay at Pi's default `codemode`
 * exposure: the model reaches them from codemode scripts (which Saale enables
 * by default), so a server with hundreds of tools does not bloat every prompt.
 */
export function toMcpServerConfig(server: McpServerRow): McpServerConfig {
  const token = readMcpToken(server);
  return {
    type: "http",
    url: server.url,
    exposure: "codemode",
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
}

/**
 * Load the enabled servers of one user, ready for the MCP extension.
 * Scoped to `userId`. a server row is only reachable through its owner.
 */
export async function loadUserMcpServers(userId: string): Promise<UserMcpServers> {
  const servers = await prisma.mcpServer.findMany({
    where: { userId, enabled: true },
    orderBy: { createdAt: "asc" },
  });

  const entries: McpServerEntry[] = [];
  const policies: Record<string, McpToolPolicy> = {};
  const oauthServers = new Map<string, McpOAuthServer>();

  for (const server of servers) {
    entries.push({
      name: server.name,
      config: toMcpServerConfig(server),
      source: "Saale settings",
      scope: "extension",
    });
    const key = mcpNameKey(server.name);
    policies[key] = isMcpToolPolicy(server.toolPolicy) ? server.toolPolicy : "ask";
    oauthServers.set(key, {
      id: server.id,
      userId: server.userId,
      name: server.name,
      url: server.url,
    });
  }

  return { entries, policies, oauthServers };
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
 * Transport for a user's server: streamable HTTP, without Pi's long-lived
 * server-to-client stream.
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
 */
function createUserMcpTransport(servers: Map<string, McpOAuthServer>): McpTransportFactory {
  return (entry) => {
    const config = entry.config;
    if (!("url" in config)) {
      throw new Error(`MCP server "${entry.name}" must be configured with a URL`);
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
export async function createUserMcpExtension(userId: string): Promise<UserMcpExtension | null> {
  const { entries, policies, oauthServers } = await loadUserMcpServers(userId);
  if (entries.length === 0) return null;

  const logPath = await getMcpLogPath(userId);

  const extension = createMcpExtension({
    // Pi asks the loader once, at session start.
    loadConfig: (): LoadedMcpConfig => ({ servers: entries, errors: [] }),
    createTransport: createUserMcpTransport(oauthServers),
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
