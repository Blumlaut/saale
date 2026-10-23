/**
 * Removing a coder chat's worktree.
 *
 * git decides whether a checkout may go: `git worktree remove` refuses a dirty
 * tree, and that refusal comes back as a `dirty-worktree` code so the user can
 * decide to discard the uncommitted work and retry with `--force`. The branch
 * and its commits stay in the repo either way, so the only thing at stake is
 * uncommitted work, which exists nowhere else.
 *
 * Order is directory first, then the row, so a failed removal leaves a record
 * that can be retried instead of a directory nobody claims.
 */

import fs from "node:fs/promises";
import { prisma } from "@/lib/db";
import { get as getPooledEntry, getPoolKey, remove as removePooled } from "@/lib/pi/agent-pool";
import { DIRTY_WORKTREE_CODE, type CoderCleanupCode } from "./cleanup-codes";
import { GitError, removeWorktree, runInWorkspace } from "./git";
import { resolveCoderPath, workspaceDirectoryExists } from "./paths";
import { stopProcessesCommand, SWEEP_TIMEOUT_SECONDS } from "./processes";
import { stopTerminalExecs } from "./terminal";

/** A removal git refused, with the reason it gave. */
export class CoderCleanupError extends Error {
  constructor(
    message: string,
    readonly status: number = 409,
    readonly code?: CoderCleanupCode,
  ) {
    super(message);
    this.name = "CoderCleanupError";
  }
}

/** git's wording for a checkout with uncommitted work. `force` overrides it. */
const DIRTY_WORKTREE_PATTERN = /contains modified or untracked files|working tree is dirty/i;

/** The code a refusal carries, when the caller can retry it with `force`. */
function refusalCode(message: string): CoderCleanupCode | undefined {
  return DIRTY_WORKTREE_PATTERN.test(message) ? DIRTY_WORKTREE_CODE : undefined;
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
 * removed. Commands the terminal panel started are stopped by id first, because
 * their command lines never name the directory. The sweep then catches the rest:
 * anything whose command line names the worktree, and anything whose working
 * directory is inside it.
 */
async function stopProcesses(
  userId: string,
  sessionId: string,
  absolutePath: string,
): Promise<void> {
  const stopped = await stopTerminalExecs(userId, sessionId);
  if (stopped > 0)
    console.warn(`[coder] stopped ${stopped} terminal command(s) in ${absolutePath}`);

  const result = await runInWorkspace(userId, {
    cwd: ".",
    command: stopProcessesCommand(absolutePath),
    timeoutSeconds: SWEEP_TIMEOUT_SECONDS,
  });
  if (result.exitCode !== 0) {
    console.warn(`[coder] stopping processes in ${absolutePath} exited ${result.exitCode}`);
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
  force: boolean = false,
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
    await stopProcesses(userId, sessionId, absolute);
    // Nothing left to compare the checkout against, so what is in it is all
    // that is left of the work done there.
    if (!project || !(await workspaceDirectoryExists(userId, project.repoPath))) {
      throw new CoderCleanupError(
        `The repo for ${worktree.path} is gone, so its files may be the only copy. Delete them by hand if you are sure.`,
      );
    }
    try {
      await removeWorktree(userId, { repoDir: project.repoPath, dir: worktree.path, force });
    } catch (err) {
      if (err instanceof GitError) {
        console.error(`git refused to remove ${worktree.path} for ${sessionId}:`, err);
        throw new CoderCleanupError(err.message, 409, refusalCode(err.message));
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
