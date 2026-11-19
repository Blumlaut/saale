/**
 * Which workspace a request is about.
 *
 * The client sends one opaque token: `user` for its own files, `machine:<id>`
 * for a server it connected to. This module turns the token into a provider
 * plus the metadata a header needs. Keeping the token opaque means the browser
 * component never learns what it is browsing, which is what makes it reusable.
 */

import { prisma } from "@/lib/db";
import { openSftpSession, remoteHome } from "@/lib/infra/client";
import { userWorkspacePath, workspaceOwner } from "@/lib/sandbox/workspace";
import { FileTargetError } from "./errors";
import { createLocalFileProvider } from "./local-provider";
import { createRemoteFileProvider } from "./remote-provider";
import { USER_FILE_TARGET, machineFileTarget, type ParsedFileTarget } from "./target-tokens";
import { FULL_CAPABILITIES, type FileTargetInfo } from "./types";
import type { FileProvider } from "./provider";

/** A resolved workspace: the backend, and what to tell the client about it. */
export interface OpenedFileTarget {
  provider: FileProvider;
  info: FileTargetInfo;
}

/**
 * A user's own workspace.
 *
 * The same directory the agent's tools work in: the workspaces volume is
 * mounted into the app at the path the container sees, so a browse, an upload
 * and a `cat` all address the same file with the same string.
 */
export async function openUserFileTarget(userId: string): Promise<OpenedFileTarget> {
  const root = userWorkspacePath(userId);
  return {
    provider: createLocalFileProvider({ root, owner: workspaceOwner() }),
    info: {
      id: USER_FILE_TARGET,
      label: "files",
      root,
      capabilities: FULL_CAPABILITIES,
    },
  };
}

/**
 * How long a machine's home directory is trusted.
 *
 * The root has to be known before the first listing, and it only changes when
 * the account behind the machine does, so one probe stands for a browser
 * session instead of one per request.
 */
const HOME_TTL_MS = 10 * 60 * 1000;
// Anchored on `globalThis` for the same reason the shells are: Next gives a
// server module a copy per route, and a cache per copy is a probe per route.
const registry = globalThis as unknown as {
  saaleRemoteHomes?: Map<string, { root: string; expires: number }>;
};
const homes = (registry.saaleRemoteHomes ??= new Map<string, { root: string; expires: number }>());

async function homeFor(machineId: string, userId: string, stamp: number): Promise<string> {
  const key = `${userId}:${machineId}:${stamp}`;
  const cached = homes.get(key);
  if (cached && cached.expires > Date.now()) return cached.root;

  let root: string;
  try {
    root = await remoteHome(machineId, userId);
  } catch (err) {
    console.error(`Failed to resolve the home directory of machine ${machineId}:`, err);
    const message = err instanceof Error ? err.message : "The machine did not answer";
    throw new FileTargetError(`Could not connect: ${message}`);
  }

  // The map holds one entry per machine per user; a long-lived process with
  // many users would keep the stale ones, so a full map starts over.
  if (homes.size > 500) homes.clear();
  homes.set(key, { root, expires: Date.now() + HOME_TTL_MS });
  return root;
}

/**
 * One of the user's machines, over SSH.
 *
 * The home directory is the root: an SFTP session lands there, and everything a
 * server is set up to reach sits below it. Ownership is checked here rather
 * than in the route, because a machine id is guessable and its credentials are
 * not.
 */
export async function openMachineFileTarget(
  userId: string,
  machineId: string,
): Promise<OpenedFileTarget> {
  const machine = await prisma.infraMachine.findFirst({
    where: { id: machineId, userId },
    select: { id: true, name: true, updatedAt: true },
  });
  if (!machine) throw new FileTargetError("That machine is not one of yours", 404);

  const root = await homeFor(machine.id, userId, machine.updatedAt.getTime());

  return {
    provider: createRemoteFileProvider({
      root,
      openSession: () => openSftpSession(machine.id, userId),
    }),
    info: {
      id: machineFileTarget(machine.id),
      label: machine.name,
      root,
      capabilities: FULL_CAPABILITIES,
    },
  };
}

/** The workspace a parsed token names. */
export async function openFileTarget(
  userId: string,
  target: ParsedFileTarget,
): Promise<OpenedFileTarget> {
  return target.kind === "machine"
    ? openMachineFileTarget(userId, target.machineId)
    : openUserFileTarget(userId);
}
