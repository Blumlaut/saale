/**
 * The app's view of a workspace directory.
 *
 * The volume is mounted into the app at the same path it is mounted at inside a
 * tenant container, so an absolute path means the same thing on both sides and
 * the file tools need no HTTP hop. One directory per identity, which is the
 * whole of the storage side of the isolation.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { requireWithinRoot } from "@/lib/files/paths";
import { isNotFoundError } from "@/lib/files/errors";
import { sandboxConfig } from "./config";
import { parseIdentity, userIdentity } from "./identity";

/** Scratch directory inside a workspace. The sandbox service empties it. */
export const WORKSPACE_TMP_DIR = ".tmp";

/** Root of the volume, as the app sees it. */
export function workspacesDir(): string {
  return sandboxConfig().workspacesDir;
}

/** Absolute path of an identity's directory. */
export function identityPath(identity: string): string {
  return path.join(workspacesDir(), parseIdentity(identity));
}

/** Absolute path of a user's own workspace. */
export function userWorkspacePath(userId: string): string {
  return identityPath(userIdentity(userId));
}

/** Absolute path of the scratch directory a workspace's files live beside. */
export function workspaceTmpPath(root: string): string {
  return path.join(root, WORKSPACE_TMP_DIR);
}

/** The owner the app gives files, taken from the account commands run as. */
export function workspaceOwner(): { uid: number; gid: number } | null {
  const config = sandboxConfig();
  // A root container ignores ownership, so there is nothing to set.
  return config.user === "root" ? null : { uid: config.uid, gid: config.gid };
}

/**
 * Hand a path to the container's account.
 *
 * The app runs as root and writes as root; a container running as `agent` could
 * not edit those files. A deployment that runs commands as root has no owner to
 * apply and skips this.
 */
export async function chownWorkspacePath(target: string): Promise<void> {
  const owner = workspaceOwner();
  if (!owner) return;
  try {
    await fs.chown(target, owner.uid, owner.gid);
  } catch (err) {
    // Without CAP_CHOWN the file is still readable in a root container; a
    // failure here is worth a line, not a failed upload.
    console.error(`Failed to hand ${target} to ${owner.uid}:${owner.gid}:`, err);
  }
}

/**
 * `mkdir -p`, handing over every directory that had to be created.
 *
 * A directory the app creates as root and leaves root-owned stops the
 * container's account from writing inside it, so the chain it made belongs to
 * that account too.
 */
async function mkdirOwned(target: string, mode?: number): Promise<void> {
  const created: string[] = [];
  let probe = target;
  for (;;) {
    try {
      await fs.stat(probe);
      break;
    } catch (err) {
      if (!isNotFoundError(err)) throw err;
      created.push(probe);
    }
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }

  await fs.mkdir(target, { recursive: true, ...(mode ? { mode } : {}) });
  for (const dir of created.reverse()) await chownWorkspacePath(dir);
}

/** Create an identity's directory, owned by the account commands run as. */
export async function ensureWorkspace(identity: string): Promise<string> {
  const dir = identityPath(identity);
  await mkdirOwned(dir, 0o770);
  await chownWorkspacePath(dir);
  return dir;
}

/** Remove an identity's directory and everything in it. */
export async function removeWorkspace(identity: string): Promise<void> {
  await fs.rm(identityPath(identity), { recursive: true, force: true });
}

/**
 * Write a file into a workspace, creating its parents.
 *
 * `absolutePath` is expected to have been resolved inside the workspace already;
 * the ownership step is the only thing this adds over `fs.writeFile`.
 */
export async function writeOwned(absolutePath: string, data: Buffer | Uint8Array): Promise<void> {
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, data);
  await chownWorkspacePath(absolutePath);
}

/**
 * Write a file at a workspace-relative path, creating its parents.
 *
 * `relative` is resolved inside the directory, so a caller-supplied file name
 * cannot reach another identity's tree.
 */
export async function writeWorkspaceFile(
  userId: string,
  relative: string,
  data: Buffer | Uint8Array,
): Promise<string> {
  const root = userWorkspacePath(userId);
  const absolute = requireWithinRoot(root, `${root}/${relative}`);
  await writeOwned(absolute, data);
  return absolute;
}
