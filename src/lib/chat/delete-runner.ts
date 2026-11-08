/**
 * The chat deletions nobody waits for.
 *
 * A coder chat's removal is a git worktree, a branch, whatever it left running
 * and a transcript directory; a normal chat's is its messages, its images and
 * its agent. None of that belongs between the click and the answer, so a delete
 * request marks the chat and this module removes it. The mark is what the lists
 * show as a greyed row, and it clears when the removal is done (or refused, so
 * the row comes back and the user can try again).
 *
 * The queue is the database rather than memory: a removal interrupted by a
 * restart is picked up on the next pass instead of leaving a chat marked
 * forever.
 */

import { prisma } from "@/lib/db";
import { CoderCleanupError, refuseChatWorktreeDelete } from "@/lib/coder/worktree-removal";
import type { CleanupCode } from "@/lib/coder/force-delete";
import { deleteChatSession } from "./delete-session";

/** How often a pass looks for what a restart left marked. */
const SWEEP_INTERVAL_MS = 30_000;

/** A chat a delete has marked, and the answer the user already gave. */
interface QueuedDelete {
  id: string;
  userId: string;
  deletingForce: boolean;
}

/** What a batch delete did: the chats on their way out, and the ones it could not start. */
export interface QueuedDeletes {
  queued: string[];
  failed: Array<{ sessionId: string; error: string; code?: CleanupCode }>;
}

/**
 * Mark one chat for removal and start the runner.
 *
 * A checkout holding work that exists nowhere else refuses here, while the user
 * still has the box that can confirm the discard.
 *
 * @throws when the chat does not exist or is not owned by the user.
 */
async function queueChatDelete(
  userId: string,
  sessionId: string,
  force: boolean = false,
): Promise<void> {
  const session = await prisma.chatSession.findFirst({
    where: { id: sessionId, userId },
    select: { projectId: true },
  });
  if (!session) throw new Error(`Chat not found: ${sessionId}`);

  if (session.projectId && !force) await refuseChatWorktreeDelete(userId, sessionId);

  await prisma.chatSession.updateMany({
    where: { id: sessionId, userId },
    data: { deletingAt: new Date(), deletingForce: force },
  });

  void runDeletes();
}

/**
 * Mark several chats for removal in one pass.
 *
 * A chat that cannot be marked (an id from another account, a checkout that
 * refuses) must not abort the batch. The caller gets back what is on its way
 * out and what is not, so it can leave the failures for a retry.
 */
export async function queueChatDeletes(
  userId: string,
  sessionIds: string[],
  force: boolean = false,
): Promise<QueuedDeletes> {
  const queued: string[] = [];
  const failed: QueuedDeletes["failed"] = [];

  // A repeated id would report a "not found" failure on its second pass.
  for (const sessionId of new Set(sessionIds)) {
    try {
      await queueChatDelete(userId, sessionId, force);
      queued.push(sessionId);
    } catch (err) {
      console.error(`Failed to queue the delete of chat session ${sessionId}:`, err);
      failed.push({
        sessionId,
        error: err instanceof Error ? err.message : String(err),
        ...(err instanceof CoderCleanupError && err.code ? { code: err.code } : {}),
      });
    }
  }

  return { queued, failed };
}

/** The pass in flight, so two callers share one walk through the queue. */
let running: Promise<void> | null = null;

/** Remove the chats a delete has marked. */
export async function runDeletes(): Promise<void> {
  running ??= drain().finally(() => {
    running = null;
  });
  return running;
}

/**
 * Look for marked chats that nothing is working on.
 *
 * Every delete request starts the runner, so this is for the one case with no
 * request behind it: a removal the previous process did not finish. Called by
 * the server's boot hook (`src/instrumentation.ts`).
 */
export function startDeleteSweep(): void {
  const timer = setInterval(() => void runDeletes(), SWEEP_INTERVAL_MS);
  // A sweep is never a reason for the process to stay up.
  timer.unref();
}

/** Work through the marked chats one at a time: each may be a git removal. */
async function drain(): Promise<void> {
  try {
    for (;;) {
      const next = await prisma.chatSession.findFirst({
        where: { deletingAt: { not: null } },
        orderBy: { deletingAt: "asc" },
        select: { id: true, userId: true, deletingForce: true },
      });
      if (!next) return;
      // A row nothing could clear would come back from this query forever.
      if (!(await remove(next))) return;
    }
  } catch (err) {
    console.error("Failed to work through the queued chat deletions:", err);
  }
}

/**
 * Remove one marked chat, and unmark it when the removal stops for a reason.
 *
 * Answers false when the chat is still marked, which is the pass's cue to stop
 * instead of asking for the same row again.
 */
async function remove(next: QueuedDelete): Promise<boolean> {
  try {
    await deleteChatSession(next.userId, next.id, next.deletingForce);
    return true;
  } catch (err) {
    console.error(`Failed to delete chat session ${next.id}:`, err);
    // The row comes back, and with it the chance to try again.
    try {
      await prisma.chatSession.updateMany({
        where: { id: next.id },
        data: { deletingAt: null, deletingForce: false },
      });
      return true;
    } catch (clearErr) {
      console.error(`Failed to unmark chat session ${next.id}:`, clearErr);
      return false;
    }
  }
}
