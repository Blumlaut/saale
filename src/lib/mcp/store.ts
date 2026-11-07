/**
 * Persistence for MCP servers, owned by an account or by the instance.
 *
 * The user's routes and the admin's shared-server routes validate, encrypt and
 * write through here, so a server stored by either path has the same shape. The
 * owner picks the table: a user's row carries `userId` on every query, an
 * instance row lives in a table with no owner column at all.
 *
 * A change rebuilds the sessions it reaches: one account's chats for a user's
 * own server, every chat for a shared one, since the server is in all of them.
 */

import type { McpServer } from "@prisma/client";
import { encrypt } from "@/lib/crypto";
import { prisma } from "@/lib/db";
import { clearMcpOAuthCredential, clearMcpOAuthFlow, hasMcpOAuthCredential } from "./oauth";
import { evictAllSessions, evictUserSessions } from "@/lib/pi/agent-pool";
import {
  isMcpToolPolicy,
  mcpNameKey,
  validateMcpServerName,
  validateMcpUrl,
  type McpToolPolicy,
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
  url?: string;
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
  url: string;
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
  url: string;
  description: string;
  token: string;
  toolPolicy: McpToolPolicy;
  enabled: boolean;
  chatEnabled: boolean;
  coderEnabled: boolean;
}

/**
 * Validate a create body.
 *
 * A name is the segment every tool of the server is named with, so an invalid
 * one is refused rather than folded: the settings sheet folds what the user
 * typed before it gets here.
 */
export function parseNewMcpServer(
  body: unknown,
): { ok: true; value: NewMcpServer } | { ok: false; status: number; error: string } {
  const input = (body ?? {}) as Record<string, unknown>;
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const url = typeof input.url === "string" ? input.url.trim() : "";

  const nameError = validateMcpServerName(name);
  if (nameError) return { ok: false, status: 400, error: nameError };
  const urlError = validateMcpUrl(url);
  if (urlError) return { ok: false, status: 400, error: urlError };
  if (input.toolPolicy !== undefined && !isMcpToolPolicy(input.toolPolicy)) {
    return { ok: false, status: 400, error: "Unknown approval setting." };
  }

  return {
    ok: true,
    value: {
      name,
      url,
      description: typeof input.description === "string" ? input.description.trim() : "",
      token: typeof input.token === "string" ? input.token.trim() : "",
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
 */
export function parseMcpServerPatch(
  body: unknown,
): { ok: true; value: McpServerColumns } | { ok: false; status: number; error: string } {
  const input = (body ?? {}) as Record<string, unknown>;
  const value: McpServerColumns = {};

  if (input.name !== undefined) {
    const name = typeof input.name === "string" ? input.name.trim() : "";
    const nameError = validateMcpServerName(name);
    if (nameError) return { ok: false, status: 400, error: nameError };
    value.name = name;
  }

  if (input.url !== undefined) {
    const url = typeof input.url === "string" ? input.url.trim() : "";
    const urlError = validateMcpUrl(url);
    if (urlError) return { ok: false, status: 400, error: urlError };
    value.url = url;
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

  return { ok: true, value };
}

/** Every server the owner has, in the order they were added. */
export async function listMcpServers(owner: McpServerOwner): Promise<McpServerRecord[]> {
  const order = { orderBy: { createdAt: "asc" } } as const;
  return owner.kind === "instance"
    ? prisma.sharedMcpServer.findMany(order)
    : prisma.mcpServer.findMany({ where: { userId: owner.userId }, ...order });
}

/** Add a server for the owner. A name another server already answers to is a conflict. */
export async function createMcpServer(
  owner: McpServerOwner,
  body: unknown,
): Promise<McpServerWrite> {
  const parsed = parseNewMcpServer(body);
  if (!parsed.ok) return parsed;
  const input = parsed.value;

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
    url: input.url,
    description: input.description,
    toolPolicy: input.toolPolicy,
    enabled: input.enabled,
    chatEnabled: input.chatEnabled,
    coderEnabled: input.coderEnabled,
    ...(input.token ? { encryptedToken: encrypt(input.token) } : {}),
  };

  const server =
    owner.kind === "instance"
      ? await prisma.sharedMcpServer.create({ data })
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
 * longer accepts.
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

  const server =
    owner.kind === "instance"
      ? await prisma.sharedMcpServer.update({ where: { id }, data })
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

async function findOwned(owner: McpServerOwner, id: string): Promise<McpServerRecord | null> {
  return owner.kind === "instance"
    ? prisma.sharedMcpServer.findFirst({ where: { id } })
    : prisma.mcpServer.findFirst({ where: { id, userId: owner.userId } });
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
