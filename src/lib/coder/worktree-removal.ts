/**
 * Removing a coder chat's worktree.
 *
 * This is where a deleted chat's checkout goes, and it decides the whole
 * question: what exists only here. A dirty tree is git's refusal, and commits
 * that no other ref carries are this module's, both reported as
 * `WORKTREE_KEPT_CODE` so the user can decide to discard them and retry with
 * `force`. A branch that is safe to drop goes with its checkout, so a project
 * does not fill up with branches nothing points at any more.
 *
 * A confirmed delete never gets stuck: git's own removal is tried with both
 * force flags, and the directory is deleted outright when git still refuses.
 * The row goes last, so a failure leaves something to retry.
 */

import { prisma } from "@/lib/db";
import { get as getPooledEntry, getPoolKey, remove as removePooled } from "@/lib/pi/agent-pool";
import { WORKTREE_KEPT_CODE, type CleanupCode } from "./force-delete";
import {
  deleteBranch,
  deleteWorktreeDirectory,
  GitError,
  isBranchPushed,
  readStatus,
  removeWorktree,
  runInWorkspace,
} from "./git";
import { resolveCoderPath, workspaceDirectoryExists } from "./paths";
import { stopProcessesCommand, SWEEP_TIMEOUT_SECONDS } from "./processes";
import { stopTerminalExecs } from "./terminal";
import { forgetTerminalRun } from "./terminal-runs";

/** A removal git refused, with the reason it gave. */
export class CoderCleanupError extends Error {
  constructor(
    message: string,
    readonly status: number = 409,
    readonly code?: CleanupCode,
  ) {
    super(message);
    this.name = "CoderCleanupError";
  }
}

/** A checkout holding work a confirmed delete was not asked to keep. */
function keptWork(message: string): CoderCleanupError {
  return new CoderCleanupError(message, 409, WORKTREE_KEPT_CODE);
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
  // The checkout is going, so the run it belonged to goes with it.
  forgetTerminalRun(userId, sessionId);

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
 * The branch holding this checkout's work that git has nowhere else, if any.
 *
 * Both are asked: the branch the chat opened on, and the one the checkout is on
 * now. A run that reviewed a pull request by checking its branch out left it
 * there, and that is where the work is. A branch git cannot see has nothing to
 * lose, so it never blocks a delete.
 */
async function unpushedBranch(
  userId: string,
  options: { repoDir: string; checkout: string | null; branch: string },
): Promise<string | null> {
  const branches = new Set([options.branch]);
  if (options.checkout) {
    const status = await readStatus(userId, options.checkout).catch((err: unknown) => {
      console.error(`Failed to read the checkout ${options.checkout}:`, err);
      return null;
    });
    if (status?.branch) branches.add(status.branch);
  }

  for (const branch of branches) {
    const pushed = await isBranchPushed(userId, options.repoDir, branch).catch((err: unknown) => {
      console.error(`Failed to read the branch ${branch} of ${options.repoDir}:`, err);
      return false;
    });
    if (!pushed) return branch;
  }
  return null;
}

/**
 * Remove a coder chat's worktree and its branch, then forget the row.
 *
 * A checkout holding work that exists nowhere else is refused with a message
 * the user can act on, and nothing is deleted: the chat stays, and so does the
 * work in it.
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

  const repoPath = project?.repoPath ?? null;
  const repoExists = repoPath !== null && (await workspaceDirectoryExists(userId, repoPath));
  const checkoutExists = await workspaceDirectoryExists(userId, worktree.path);

  if (repoExists && repoPath !== null) {
    const branch = await unpushedBranch(userId, {
      repoDir: repoPath,
      checkout: checkoutExists ? worktree.path : null,
      branch: worktree.branch,
    });
    if (branch && !force) {
      throw keptWork(
        `The branch ${branch} has commits that exist nowhere else. Push them, or delete the checkout anyway.`,
      );
    }
  }

  if (checkoutExists) {
    await stopProcesses(userId, sessionId, resolveCoderPath(userId, worktree.path));

    // Nothing left to compare the checkout against, so what is in it is all
    // that is left of the work done there.
    if (repoPath === null || !repoExists) {
      if (!force) {
        throw keptWork(
          `The repo for ${worktree.path} is gone, so its files may be the only copy. Delete them by hand if you are sure.`,
        );
      }
      await deleteWorktreeDirectory(userId, worktree.path);
    } else {
      try {
        await removeWorktree(userId, { repoDir: repoPath, dir: worktree.path, force });
      } catch (err) {
        if (err instanceof GitError && !force) {
          console.error(`git refused to remove ${worktree.path} for ${sessionId}:`, err);
          throw keptWork(err.message);
        }
        throw err;
      }
    }
  }

  await prisma.coderWorktree.update({
    where: { sessionId },
    data: { status: "removed", removedAt: new Date() },
  });

  if (repoExists && repoPath !== null) {
    await deleteBranch(userId, { repoDir: repoPath, branch: worktree.branch }).catch(
      (err: unknown) => {
        // The chat is gone either way; a branch left behind is git's to explain.
        console.error(`Failed to delete the branch ${worktree.branch} of ${sessionId}:`, err);
      },
    );
  }

  const poolKey = getPoolKey(userId, sessionId);
  if (getPooledEntry(poolKey)) await removePooled(poolKey);

  return { path: worktree.path, removed: true };
}
