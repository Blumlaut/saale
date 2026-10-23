/**
 * Removing a coder chat's worktree.
 *
 * git decides whether a checkout may go: `git worktree remove` refuses a dirty
 * tree, and that refusal is the answer, never something to retry with
 * `--force`. The branch and its commits stay in the repo either way, so the
 * only thing at stake is uncommitted work. which exists nowhere else.
 *
 * Order is directory first, then the row, so a failed removal leaves a record
 * that can be retried instead of a directory nobody claims.
 */

import fs from "node:fs/promises";
import { prisma } from "@/lib/db";
import { get as getPooledEntry, getPoolKey, remove as removePooled } from "@/lib/pi/agent-pool";
import { GitError, removeWorktree, runInWorkspace, shellQuote } from "./git";
import { resolveCoderPath } from "./paths";

/** A removal git refused, with the reason it gave. */
export class CoderCleanupError extends Error {
  constructor(
    message: string,
    readonly status: number = 409,
  ) {
    super(message);
    this.name = "CoderCleanupError";
  }
}

/** What removing a chat's worktree did. */
export interface RemovedWorktree {
  /** The workspace-relative path, or null when the chat had no worktree. */
  path: string | null;
  removed: boolean;
}

/**
 * Stop whatever is still running inside a worktree.
 *
 * A dev server or a watcher the agent left behind holds its files open and
 * keeps working after the chat is gone, so it is killed before the checkout is
 * removed. `pkill -f` matches the absolute path, which only commands started in
 * that directory carry.
 */
async function stopProcesses(userId: string, absolutePath: string): Promise<void> {
  const result = await runInWorkspace(userId, {
    cwd: ".",
    command: `pkill -f ${shellQuote(absolutePath)} >/dev/null 2>&1`,
  });
  // 1 is "nothing matched", which is the ordinary case.
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    console.warn(`[coder] pkill in ${absolutePath} exited ${result.exitCode}: ${result.stderr}`);
  }
}

/**
 * Remove a coder chat's worktree, then forget the row.
 *
 * A dirty checkout is refused with git's own message, and nothing is deleted:
 * the chat stays, and so does the work in it.
 */
export async function removeChatWorktree(
  userId: string,
  sessionId: string,
): Promise<RemovedWorktree> {
  const chat = await prisma.chatSession.findFirst({
    where: { id: sessionId, userId },
    select: { projectId: true },
  });
  if (!chat || !chat.projectId) return { path: null, removed: false };

  const project = await prisma.coderProject.findFirst({
    where: { id: chat.projectId, userId },
    select: { repoPath: true },
  });
  const worktree = await prisma.coderWorktree.findUnique({ where: { sessionId } });
  if (!worktree || worktree.status !== "active") return { path: null, removed: false };

  const absolute = resolveCoderPath(userId, worktree.path);
  const exists = await fs
    .stat(absolute)
    .then(() => true)
    .catch((err: unknown) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    });

  if (exists) {
    await stopProcesses(userId, absolute);
    // A repo that is gone cannot remove its own worktree; the directory is
    // then all that is left of the branch, so it stays for a human.
    if (!project) {
      throw new CoderCleanupError(
        "The project this worktree belongs to is gone, so its files may be the only copy. Delete them by hand if you are sure.",
      );
    }
    try {
      await removeWorktree(userId, { repoDir: project.repoPath, dir: worktree.path });
    } catch (err) {
      if (err instanceof GitError) {
        console.error(`git refused to remove ${worktree.path} for ${sessionId}:`, err);
        throw new CoderCleanupError(err.message);
      }
      throw err;
    }
  }

  await prisma.coderWorktree.update({
    where: { sessionId },
    data: { status: "removed", removedAt: new Date() },
  });

  const poolKey = getPoolKey(userId, sessionId);
  if (getPooledEntry(poolKey)) await removePooled(poolKey);

  return { path: worktree.path, removed: true };
}
