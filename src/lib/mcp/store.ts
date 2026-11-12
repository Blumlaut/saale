/**
 * Persistence for MCP servers, owned by an account or by the instance.
 *
 * The user's routes and the admin's shared-server routes validate, encrypt and
 * write through here, so a server stored by either path has the same shape. The
 * owner picks the table: a user's row carries `userId` on every query, an
 * instance row lives in a table with no owner column at all.
 *
 * An account's server is an HTTP endpoint or a command that runs in that
 * account's workspace. An instance's server is an HTTP endpoint only: a command
 * would have to run in somebody's container, and there is no answer to whose.
 *
 * A change rebuilds the sessions it reaches: one account's chats for a user's
 * own server, every chat for a shared one, since the server is in all of them.
 */

import type { McpServer, SharedMcpServer } from "@prisma/client";
import { encrypt } from "@/lib/crypto";
import { prisma } from "@/lib/db";
import { clearMcpOAuthCredential, clearMcpOAuthFlow, hasMcpOAuthCredential } from "./oauth";
import { evictAllSessions, evictUserSessions } from "@/lib/pi/agent-pool";
import {
  isMcpToolPolicy,
  isMcpTransport,
  mcpNameKey,
  parseMcpEnv,
  parseMcpEnvRemove,
  validateMcpCommand,
  validateMcpCwd,
  validateMcpServerName,
  validateMcpUrl,
  type McpEnv,
  type McpToolPolicy,
  type McpTransport,
} from "./shared";

/** A server row, whichever table it came from. */
export type McpServerRecord = Omit<McpServer, "userId">;

/** Who owns the server rows a call works on. */
export type McpServerOwner = { kind: "user"; userId: string } | { kind: "instance" };

/** The instance's servers: written by an admin, connected by every account. */
export const INSTANCE_MCP_SERVERS: McpServerOwner = { kind: "instance" };

/** One account's servers. */
export function userMcpServers(userId: string): McpServerOwner {
  return { kind: "user", userId };
}

/** The columns an owner's create or update may write. */
interface McpServerColumns {
  name?: string;
  transport?: McpTransport;
  url?: string | null;
  command?: string | null;
  cwd?: string | null;
  /** The whole column: name to ciphertext, in JSON. */
  env?: string | null;
  description?: string;
  encryptedToken?: string | null;
  toolPolicy?: string;
  enabled?: boolean;
  chatEnabled?: boolean;
  coderEnabled?: boolean;
}

/** The columns a new server is written with. */
interface NewMcpServerColumns extends McpServerColumns {
  name: string;
  transport: McpTransport;
  url: string | null;
  command: string | null;
  cwd: string | null;
  toolPolicy: string;
  enabled: boolean;
  chatEnabled: boolean;
  coderEnabled: boolean;
}

export type McpServerWrite =
  | { ok: true; server: McpServerRecord; hasOAuth: boolean }
  | { ok: false; status: number; error: string };

/** The columns a new server is created with, once its body validated. */
export interface NewMcpServer {
  name: string;
  transport: McpTransport;
  url: string | null;
  command: string | null;
  cwd: string | null;
  /** The command's own variables, as the user typed them. */
  env: McpEnv;
  description: string;
  token: string;
  toolPolicy: McpToolPolicy;
  enabled: boolean;
  chatEnabled: boolean;
  coderEnabled: boolean;
}

type ParseFailure = { ok: false; status: number; error: string };

/**
 * Validate a create body.
 *
 * A name is the segment every tool of the server is named with, so an invalid
 * one is refused rather than folded: the settings sheet folds what the user
 * typed before it gets here. An HTTP server needs its URL, a command server its
 * command; the other one of the two is stored empty.
 */
export function parseNewMcpServer(body: unknown): { ok: true; value: NewMcpServer } | ParseFailure {
  const input = (body ?? {}) as Record<string, unknown>;
  const name = typeof input.name === "string" ? input.name.trim() : "";

  const nameError = validateMcpServerName(name);
  if (nameError) return { ok: false, status: 400, error: nameError };
  if (input.toolPolicy !== undefined && !isMcpToolPolicy(input.toolPolicy)) {
    return { ok: false, status: 400, error: "Unknown approval setting." };
  }

  const transport = input.transport === undefined ? "http" : input.transport;
  if (!isMcpTransport(transport)) {
    return { ok: false, status: 400, error: "Unknown connection type." };
  }

  const target =
    transport === "stdio"
      ? stdioTarget(input)
      : httpTarget(typeof input.url === "string" ? input.url.trim() : "");
  if (!target.ok) return target;

  // Variables belong to a command; an endpoint authenticates with its token.
  const parsedEnv = parseMcpEnv(transport === "stdio" ? input.env : undefined);
  if (!parsedEnv.ok) return { ok: false, status: 400, error: parsedEnv.error };

  return {
    ok: true,
    value: {
      name,
      transport,
      url: target.url,
      command: target.command,
      cwd: target.cwd,
      env: parsedEnv.value,
      description: typeof input.description === "string" ? input.description.trim() : "",
      // A command authenticates with the account's own variables, so a bearer
      // token means nothing to it and is not stored.
      token: transport === "http" && typeof input.token === "string" ? input.token.trim() : "",
      toolPolicy: isMcpToolPolicy(input.toolPolicy) ? input.toolPolicy : "ask",
      enabled: typeof input.enabled === "boolean" ? input.enabled : true,
      chatEnabled: typeof input.chatEnabled === "boolean" ? input.chatEnabled : true,
      coderEnabled: typeof input.coderEnabled === "boolean" ? input.coderEnabled : true,
    },
  };
}

/**
 * Validate an update body. An omitted field keeps its value; `token: ""` clears
 * the stored token, any other string replaces it.
 *
 * Which fields a server needs depends on the transport it ends up with, and only
 * the stored row knows the half a patch leaves out, so `updateMcpServer` checks
 * the combination once it has read the row.
 */
export function parseMcpServerPatch(
  body: unknown,
): { ok: true; value: McpServerColumns; envSet?: McpEnv; envRemove?: string[] } | ParseFailure {
  const input = (body ?? {}) as Record<string, unknown>;
  const value: McpServerColumns = {};

  if (input.name !== undefined) {
    const name = typeof input.name === "string" ? input.name.trim() : "";
    const nameError = validateMcpServerName(name);
    if (nameError) return { ok: false, status: 400, error: nameError };
    value.name = name;
  }

  if (input.transport !== undefined) {
    if (!isMcpTransport(input.transport)) {
      return { ok: false, status: 400, error: "Unknown connection type." };
    }
    value.transport = input.transport;
  }

  if (input.url !== undefined) {
    const url = typeof input.url === "string" ? input.url.trim() : "";
    if (url) {
      const urlError = validateMcpUrl(url);
      if (urlError) return { ok: false, status: 400, error: urlError };
    }
    value.url = url || null;
  }

  if (input.command !== undefined) {
    const command = typeof input.command === "string" ? input.command.trim() : "";
    if (command) {
      const commandError = validateMcpCommand(command);
      if (commandError) return { ok: false, status: 400, error: commandError };
    }
    value.command = command || null;
  }

  if (input.cwd !== undefined) {
    const cwd = typeof input.cwd === "string" ? input.cwd.trim() : "";
    const cwdError = validateMcpCwd(cwd);
    if (cwdError) return { ok: false, status: 400, error: cwdError };
    value.cwd = cwd || null;
  }

  if (input.description !== undefined) {
    value.description = typeof input.description === "string" ? input.description.trim() : "";
  }

  if (input.toolPolicy !== undefined) {
    if (!isMcpToolPolicy(input.toolPolicy)) {
      return { ok: false, status: 400, error: "Unknown approval setting." };
    }
    value.toolPolicy = input.toolPolicy;
  }

  for (const field of ["enabled", "chatEnabled", "coderEnabled"] as const) {
    const next = input[field];
    if (next === undefined) continue;
    if (typeof next !== "boolean") {
      return { ok: false, status: 400, error: `${field} must be a boolean` };
    }
    value[field] = next;
  }

  if (input.token !== undefined) {
    const token = typeof input.token === "string" ? input.token.trim() : "";
    value.encryptedToken = token ? encrypt(token) : null;
  }

  // Variables are touched by name, so a patch never has to send the values it
  // cannot read back.
  const parsedEnv = parseMcpEnv(input.env);
  if (!parsedEnv.ok) return { ok: false, status: 400, error: parsedEnv.error };
  const parsedRemove = parseMcpEnvRemove(input.envRemove);
  if (!parsedRemove.ok) return { ok: false, status: 400, error: parsedRemove.error };

  return {
    ok: true,
    value,
    ...(Object.keys(parsedEnv.value).length > 0 ? { envSet: parsedEnv.value } : {}),
    ...(parsedRemove.value.length > 0 ? { envRemove: parsedRemove.value } : {}),
  };
}

/** An HTTP server's columns: an endpoint and nothing to run. */
function httpTarget(
  url: string,
): ParseFailure | { ok: true; url: string; command: null; cwd: null } {
  const urlError = validateMcpUrl(url);
  if (urlError) return { ok: false, status: 400, error: urlError };
  return { ok: true, url, command: null, cwd: null };
}

/** A command server's columns: a command, its directory, and no endpoint. */
function stdioTarget(
  input: Record<string, unknown>,
): ParseFailure | { ok: true; url: null; command: string; cwd: string | null } {
  const command = typeof input.command === "string" ? input.command.trim() : "";
  const commandError = validateMcpCommand(command);
  if (commandError) return { ok: false, status: 400, error: commandError };

  const cwd = typeof input.cwd === "string" ? input.cwd.trim() : "";
  const cwdError = validateMcpCwd(cwd);
  if (cwdError) return { ok: false, status: 400, error: cwdError };

  return { ok: true, url: null, command, cwd: cwd || null };
}

/** Every server the owner has, in the order they were added. */
export async function listMcpServers(owner: McpServerOwner): Promise<McpServerRecord[]> {
  const order = { orderBy: { createdAt: "asc" } } as const;
  if (owner.kind === "instance") {
    const rows = await prisma.sharedMcpServer.findMany(order);
    return rows.map(asInstanceRecord);
  }
  return prisma.mcpServer.findMany({ where: { userId: owner.userId }, ...order });
}

/** Add a server for the owner. A name another server already answers to is a conflict. */
export async function createMcpServer(
  owner: McpServerOwner,
  body: unknown,
): Promise<McpServerWrite> {
  const parsed = parseNewMcpServer(body);
  if (!parsed.ok) return parsed;
  const input = parsed.value;

  if (owner.kind === "instance" && input.transport === "stdio") {
    return {
      ok: false,
      status: 400,
      error:
        "A shared server has to be an HTTP endpoint, since a command runs in one account's workspace.",
    };
  }
  if (owner.kind === "instance" && Object.keys(input.env).length > 0) {
    return {
      ok: false,
      status: 400,
      error: "A shared server cannot carry variables: each account supplies its own.",
    };
  }

  const taken = await takenNames(owner, null);
  if (taken.some((name) => mcpNameKey(name) === mcpNameKey(input.name))) {
    return {
      ok: false,
      status: 409,
      error: `A server named "${input.name}" is already configured.`,
    };
  }

  const data: NewMcpServerColumns = {
    name: input.name,
    transport: input.transport,
    url: input.url,
    command: input.command,
    cwd: input.cwd,
    description: input.description,
    toolPolicy: input.toolPolicy,
    enabled: input.enabled,
    chatEnabled: input.chatEnabled,
    coderEnabled: input.coderEnabled,
    ...(input.token ? { encryptedToken: encrypt(input.token) } : {}),
    ...(input.transport === "stdio" && Object.keys(input.env).length > 0
      ? { env: sealEnv(input.env) }
      : {}),
  };

  const server =
    owner.kind === "instance"
      ? asInstanceRecord(
          await prisma.sharedMcpServer.create({
            data: {
              name: data.name,
              url: data.url ?? "",
              description: data.description ?? "",
              toolPolicy: data.toolPolicy ?? "ask",
              enabled: data.enabled ?? true,
              chatEnabled: data.chatEnabled ?? true,
              coderEnabled: data.coderEnabled ?? true,
              ...(data.encryptedToken ? { encryptedToken: data.encryptedToken } : {}),
            },
          }),
        )
      : await prisma.mcpServer.create({ data: { userId: owner.userId, ...data } });

  // Pooled chats were built against the previous server list.
  await evictFor(owner);
  return { ok: true, server, hasOAuth: false };
}

/**
 * Update a server the owner has, or null when it has none of that id.
 *
 * A sign-in issued for another endpoint is dropped: Pi ignores state for
 * another URL anyway, and keeping it would report a connection the server no
 * longer accepts. Switching transport drops what the other one needed, so a row
 * never carries an endpoint and a command at once.
 */
export async function updateMcpServer(
  owner: McpServerOwner,
  id: string,
  body: unknown,
): Promise<McpServerWrite | null> {
  const existing = await findOwned(owner, id);
  if (!existing) return null;

  const parsed = parseMcpServerPatch(body);
  if (!parsed.ok) return parsed;
  const data = parsed.value;

  if (data.name !== undefined) {
    const taken = await takenNames(owner, id);
    if (taken.some((name) => mcpNameKey(name) === mcpNameKey(data.name!))) {
      return {
        ok: false,
        status: 409,
        error: `A server named "${data.name}" is already configured.`,
      };
    }
  }

  const transport =
    data.transport ?? (isMcpTransport(existing.transport) ? existing.transport : "http");
  if (owner.kind === "instance" && transport === "stdio") {
    return {
      ok: false,
      status: 400,
      error:
        "A shared server has to be an HTTP endpoint, since a command runs in one account's workspace.",
    };
  }

  if (owner.kind === "instance" && (parsed.envSet || parsed.envRemove)) {
    return {
      ok: false,
      status: 400,
      error: "A shared server cannot carry variables: each account supplies its own.",
    };
  }

  if (transport !== "stdio" && (parsed.envSet || parsed.envRemove)) {
    return {
      ok: false,
      status: 400,
      error: "Only a command server carries variables.",
    };
  }

  // A patch that only toggles a switch writes only that switch; one that touches
  // where the server lives is completed and normalized as a whole.
  const touchesTarget =
    data.transport !== undefined ||
    data.url !== undefined ||
    data.command !== undefined ||
    data.cwd !== undefined;

  if (touchesTarget && transport === "stdio") {
    const command = data.command ?? existing.command;
    const commandError = command
      ? validateMcpCommand(command)
      : "Enter the command that starts the server.";
    if (commandError) return { ok: false, status: 400, error: commandError };
    data.transport = "stdio";
    data.command = command;
    data.url = null;
    data.encryptedToken = null;
  } else if (touchesTarget) {
    const url = data.url ?? existing.url;
    const urlError = url ? validateMcpUrl(url) : "Enter the server's URL.";
    if (urlError) return { ok: false, status: 400, error: urlError };
    data.transport = "http";
    data.url = url;
    data.command = null;
    data.cwd = null;
  }

  if (parsed.envSet || parsed.envRemove) {
    data.env = mergeEnv(existing.env ?? null, parsed.envSet ?? {}, parsed.envRemove ?? []);
  }

  const server =
    owner.kind === "instance"
      ? asInstanceRecord(
          await prisma.sharedMcpServer.update({ where: { id }, data: sharedColumns(data) }),
        )
      : await prisma.mcpServer.update({ where: { id, userId: owner.userId }, data });

  const urlChanged = data.url !== undefined && data.url !== existing.url;
  let hasOAuth = false;
  if (owner.kind === "user") {
    if (urlChanged) await clearMcpOAuthCredential(owner.userId, id);
    hasOAuth = urlChanged ? false : await hasMcpOAuthCredential(owner.userId, id);
  }

  await evictFor(owner);
  return { ok: true, server, hasOAuth };
}

/** Remove a server the owner has. Returns false when nothing matched. */
export async function deleteMcpServer(owner: McpServerOwner, id: string): Promise<boolean> {
  const removed =
    owner.kind === "instance"
      ? await prisma.sharedMcpServer.deleteMany({ where: { id } })
      : await prisma.mcpServer.deleteMany({ where: { id, userId: owner.userId } });
  if (removed.count === 0) return false;

  // A credential row cascades with the server; the short-lived sign-in state
  // does not, so forget it explicitly.
  if (owner.kind === "user") await clearMcpOAuthFlow(id);
  await evictFor(owner);
  return true;
}

/**
 * An instance row in the shape the routes and the Pi config read.
 *
 * The shared table has no transport columns: every shared server is an HTTP
 * endpoint, which is why there is nothing to carry over.
 */
function asInstanceRecord(row: SharedMcpServer): McpServerRecord {
  return { ...row, transport: "http", command: null, cwd: null, env: null };
}

/** The columns the shared table has, out of a patch that may hold transport-only ones. */
function sharedColumns(data: McpServerColumns) {
  return {
    ...(data.name !== undefined ? { name: data.name } : {}),
    ...(typeof data.url === "string" ? { url: data.url } : {}),
    ...(data.description !== undefined ? { description: data.description } : {}),
    ...(data.encryptedToken !== undefined ? { encryptedToken: data.encryptedToken } : {}),
    ...(data.toolPolicy !== undefined ? { toolPolicy: data.toolPolicy } : {}),
    ...(data.enabled !== undefined ? { enabled: data.enabled } : {}),
    ...(data.chatEnabled !== undefined ? { chatEnabled: data.chatEnabled } : {}),
    ...(data.coderEnabled !== undefined ? { coderEnabled: data.coderEnabled } : {}),
  };
}

/**
 * A server's variables, sealed: name to AES-256-GCM ciphertext, in JSON.
 *
 * The token column keeps its own ciphertext; this is the same crypto applied to
 * a map, so the API can answer with names and the command can start with values.
 */
function sealEnv(env: McpEnv): string {
  const sealed: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) sealed[name] = encrypt(value);
  return JSON.stringify(sealed);
}

/**
 * The sealed map after a patch: values it set, names it removed.
 *
 * Nothing is decrypted here: the stored values are already ciphertext and a
 * patch only ever adds to them or drops them.
 */
function mergeEnv(current: string | null, set: McpEnv, remove: string[]): string | null {
  const sealed: Record<string, string> = {};
  if (current) {
    try {
      const parsed: unknown = JSON.parse(current);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof value === "string") sealed[name] = value;
        }
      }
    } catch (err) {
      console.error("Failed to read stored MCP variables; replacing them:", err);
    }
  }

  for (const name of remove) delete sealed[name];
  for (const [name, value] of Object.entries(set)) sealed[name] = encrypt(value);

  return Object.keys(sealed).length > 0 ? JSON.stringify(sealed) : null;
}

async function findOwned(owner: McpServerOwner, id: string): Promise<McpServerRecord | null> {
  if (owner.kind === "user")
    return prisma.mcpServer.findFirst({ where: { id, userId: owner.userId } });
  const row = await prisma.sharedMcpServer.findFirst({ where: { id } });
  return row ? asInstanceRecord(row) : null;
}

/** The names the owner's servers answer to, leaving out the row being edited. */
async function takenNames(owner: McpServerOwner, exceptId: string | null): Promise<string[]> {
  const rows =
    owner.kind === "instance"
      ? await prisma.sharedMcpServer.findMany({
          where: exceptId ? { id: { not: exceptId } } : {},
          select: { name: true },
        })
      : await prisma.mcpServer.findMany({
          where: exceptId
            ? { userId: owner.userId, id: { not: exceptId } }
            : { userId: owner.userId },
          select: { name: true },
        });
  return rows.map((row) => row.name);
}

/** Rebuild the pooled chats a server change reaches. */
async function evictFor(owner: McpServerOwner): Promise<void> {
  if (owner.kind === "instance") await evictAllSessions();
  else await evictUserSessions(owner.userId);
}
