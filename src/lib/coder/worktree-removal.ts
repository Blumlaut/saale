/**
 * Removing a coder chat's worktree.
 *
 * This is where a deleted chat's checkout goes, and it decides the whole
 * question: what exists only here. Commits that no other ref carries, changes
 * that were never committed and a checkout whose repo is gone are all refused
 * as `WORKTREE_KEPT_CODE`, so the user can decide to discard them and retry
 * with `force`. A branch that is safe to drop goes with its checkout, so a
 * project does not fill up with branches nothing points at any more.
 *
 * The refusal is decided before anything is removed, so the delete box can ask
 * while the chat is still whole, and a delete the user asked for in the
 * background stops before it touches a thing.
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
} from "./git";
import { resolveCoderPath, workspaceDirectoryExists } from "./paths";
import { stopChatProcesses } from "./processes";

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

/** A chat's checkout as a delete sees it, before anything is removed. */
interface ChatCheckout {
  /** The workspace-relative path of the checkout. */
  path: string;
  /** The branch the chat opened on. */
  branch: string;
  repoPath: string | null;
  repoExists: boolean;
  checkoutExists: boolean;
  /** The branch the checkout is on now, "" when git could not be asked. */
  currentBranch: string;
  /** Whether the checkout holds changes git would refuse to throw away. */
  dirty: boolean;
}

/**
 * The checkout a chat would lose, or null when it has none to lose.
 *
 * `null` covers a normal chat, a coder chat that never built a worktree, and
 * one whose checkout was already removed.
 */
async function readChatCheckout(userId: string, sessionId: string): Promise<ChatCheckout | null> {
  const chat = await prisma.chatSession.findFirst({
    where: { id: sessionId, userId },
    select: { projectId: true },
  });
  if (!chat || !chat.projectId) return null;

  const project = await prisma.coderProject.findFirst({
    where: { id: chat.projectId, userId },
    select: { repoPath: true },
  });
  const worktree = await prisma.coderWorktree.findUnique({ where: { sessionId } });
  if (!worktree || worktree.status !== "active") return null;

  const repoPath = project?.repoPath ?? null;
  const repoExists = repoPath !== null && (await workspaceDirectoryExists(userId, repoPath));
  const checkoutExists = await workspaceDirectoryExists(userId, worktree.path);
  const status = checkoutExists
    ? await readStatus(userId, worktree.path).catch((err: unknown) => {
        console.error(`Failed to read the checkout ${worktree.path}:`, err);
        return null;
      })
    : null;

  return {
    path: worktree.path,
    branch: worktree.branch,
    repoPath,
    repoExists,
    checkoutExists,
    currentBranch: status?.branch ?? "",
    dirty: (status?.files.length ?? 0) > 0,
  };
}

/**
 * Why a plain delete keeps this checkout, if it does.
 *
 * Both branches are asked: the one the chat opened on, and the one the checkout
 * is on now. A run that reviewed a pull request by checking its branch out left
 * it there, and that is where the work is. A branch git cannot see has nothing
 * to lose, so it never blocks a delete.
 */
async function keptWorkReason(userId: string, checkout: ChatCheckout): Promise<string | null> {
  if (checkout.repoExists && checkout.repoPath !== null) {
    const branches = new Set([checkout.branch]);
    if (checkout.currentBranch) branches.add(checkout.currentBranch);

    for (const branch of branches) {
      const pushed = await isBranchPushed(userId, checkout.repoPath, branch).catch(
        (err: unknown) => {
          console.error(`Failed to read the branch ${branch} of ${checkout.repoPath}:`, err);
          return false;
        },
      );
      if (!pushed) {
        return `The branch ${branch} has commits that exist nowhere else. Push them, or delete the checkout anyway.`;
      }
    }
  }

  if (checkout.checkoutExists && (!checkout.repoExists || checkout.repoPath === null)) {
    return `The repo for ${checkout.path} is gone, so its files may be the only copy. Delete them by hand if you are sure.`;
  }

  if (checkout.checkoutExists && checkout.dirty) {
    return `The checkout ${checkout.path} has changes that were never committed. Commit them, or delete the checkout anyway.`;
  }

  return null;
}

/**
 * Throw what a plain delete of this chat's checkout would stop for.
 *
 * Nothing is removed, so a delete that asks the question first leaves the work
 * exactly where it was until the answer comes back.
 */
export async function refuseChatWorktreeDelete(userId: string, sessionId: string): Promise<void> {
  const checkout = await readChatCheckout(userId, sessionId);
  if (!checkout) return;

  const reason = await keptWorkReason(userId, checkout);
  if (reason) throw keptWork(reason);
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
  const checkout = await readChatCheckout(userId, sessionId);
  if (!checkout) return { path: null, removed: false };

  if (!force) {
    const reason = await keptWorkReason(userId, checkout);
    if (reason) throw keptWork(reason);
  }

  const { path, branch, repoPath, repoExists, checkoutExists } = checkout;

  if (checkoutExists) {
    // The checkout is about to go, so everything the chat left running goes
    // first.
    await stopChatProcesses(userId, sessionId, { ownCheckout: resolveCoderPath(userId, path) });

    if (repoPath === null || !repoExists) {
      // Nothing left to compare the checkout against, so what is in it is all
      // that is left of the work done there.
      await deleteWorktreeDirectory(userId, path);
    } else {
      try {
        await removeWorktree(userId, { repoDir: repoPath, dir: path, force });
      } catch (err) {
        if (err instanceof GitError && !force) {
          console.error(`git refused to remove ${path} for ${sessionId}:`, err);
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
    await deleteBranch(userId, { repoDir: repoPath, branch }).catch((err: unknown) => {
      // The chat is gone either way; a branch left behind is git's to explain.
      console.error(`Failed to delete the branch ${branch} of ${sessionId}:`, err);
    });
  }

  const poolKey = getPoolKey(userId, sessionId);
  if (getPooledEntry(poolKey)) await removePooled(poolKey);

  return { path, removed: true };
}
