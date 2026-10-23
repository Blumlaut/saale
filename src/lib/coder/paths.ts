/**
 * Where coder files live.
 *
 * A project's repo and a chat's worktree are both directories in the user's
 * workspace, which is the one filesystem the file tools and the file browser
 * already serve. The database stores workspace-relative paths, so a workspace
 * that moves (a new volume, a different mount) needs no data fix, and every
 * absolute path is derived here and re-checked against the workspace root
 * before it reaches git or the container.
 */

import fs from "node:fs/promises";
import { requireWithinRoot } from "@/lib/files/paths";
import { isNotFoundError } from "@/lib/files/errors";
import { userWorkspacePath } from "@/lib/sandbox/workspace";
import { coderChatSlug, isCoderSlug } from "./slug";

/** Repos, one directory per project. */
export const PROJECTS_DIR = "projects";

/** Checkouts, one directory per coder chat. */
export const WORKTREES_DIR = "worktrees";

/** Absolute root of a user's workspace. */
export function coderWorkspaceRoot(userId: string): string {
  return userWorkspacePath(userId);
}

function assertSlug(slug: string, what: string): string {
  if (!isCoderSlug(slug)) throw new Error(`Not a ${what} slug: ${slug}`);
  return slug;
}

/** `projects/<slug>`, as stored in `CoderProject.repoPath`. */
export function projectRepoPath(slug: string): string {
  return `${PROJECTS_DIR}/${assertSlug(slug, "project")}`;
}

/** `worktrees/<project>/<chat>`, as stored in `CoderWorktree.path`. */
export function worktreePath(projectSlug: string, sessionId: string): string {
  const chat = coderChatSlug(sessionId);
  return `${WORKTREES_DIR}/${assertSlug(projectSlug, "project")}/${chat}`;
}

/**
 * A workspace-relative path as an absolute one inside `userId`'s workspace.
 *
 * The single gate every coder path passes: a stored path is re-validated on
 * every use, so a row edited to `../../etc` cannot reach a shell.
 */
export function resolveCoderPath(userId: string, relative: string): string {
  // A relative path is taken from the root; an absolute one is refused, because
  // nothing stored here is absolute.
  return requireWithinRoot(coderWorkspaceRoot(userId), relative);
}

/** The relative form of an absolute path inside the workspace, or null. */
export function coderPathRelativeTo(userId: string, absolute: string): string | null {
  const root = coderWorkspaceRoot(userId);
  if (absolute === root) return "";
  return absolute.startsWith(`${root}/`) ? absolute.slice(root.length + 1) : null;
}

/**
 * Whether a directory is still on disk.
 *
 * A directory deleted by hand leaves a row behind, so anything that is about to
 * run git in one asks this first: git has nothing to say about a directory that
 * is not there, and its failure reads like a refusal.
 */
export async function workspaceDirectoryExists(userId: string, relative: string): Promise<boolean> {
  const stat = await fs.stat(resolveCoderPath(userId, relative)).catch((err: unknown) => {
    if (isNotFoundError(err)) return null;
    throw err;
  });
  return stat?.isDirectory() ?? false;
}

/** `.gitconfig` at the workspace root, which is `$HOME` in the container. */
export const GITCONFIG_FILE = ".gitconfig";
