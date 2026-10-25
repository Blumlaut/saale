/**
 * Deleting a chat. shared by the delete route (the sidebar action, the
 * sendBeacon on tab close) and the `chat_delete` tool, so a chat removed by an
 * agent is cleaned up exactly like one removed from the UI.
 *
 * Order of operations:
 * 1. Verify ownership (`userId` in the query. an id-only delete would let a
 *    guessed id remove another user's chat)
 * 2. For a coder chat, remove its worktree and its branch. A checkout holding
 *    work that exists nowhere else refuses, and that refusal aborts the delete,
 *    so the chat never outlives its work
 * 3. Delete attachment files from disk (fails fast, leaving the DB intact)
 * 4. Delete the session row (cascade removes messages + attachment records +
 *    watcher rows)
 * 5. Unschedule the chat's watchers (the cascade cannot reach BullMQ state)
 * 6. Release the pooled agent and Pi's transcript directory
 */

import fs from "fs/promises";
import { prisma } from "@/lib/db";
import { deleteAllImages } from "@/lib/image-attachment";
import { isSessionActive } from "@/lib/redis";
import { unscheduleWatcher } from "@/lib/queue";
import { keepAutoDeletedSession, type AutoDeleteKeepReason } from "./auto-delete";
import { getProvisioning } from "@/lib/coder/provisioning";
import { getPoolKey, getSessionDir, remove } from "@/lib/pi/agent-pool";
import { removeChatWorktree, CoderCleanupError } from "@/lib/coder/worktree-removal";
import type { CleanupCode } from "@/lib/coder/force-delete";

/** The deleted chat's title, for a confirmation message. */
export interface DeletedChat {
  title: string;
}

/** What the automatic delete did, and why when it did nothing. */
export type AutoDeleteResult = { deleted: true } | { deleted: false; kept: AutoDeleteKeepReason };

/** Outcome of a multi-chat delete: what went, and what is still there. */
export interface BulkDeleteResult {
  deleted: string[];
  failed: Array<{ sessionId: string; error: string; code?: CleanupCode }>;
}

/**
 * Delete one of a user's chats and everything that belongs to it.
 *
 * @throws when the chat does not exist or is not owned by the user.
 */
export async function deleteChatSession(
  userId: string,
  sessionId: string,
  force: boolean = false,
): Promise<DeletedChat> {
  const session = await prisma.chatSession.findFirst({
    where: { id: sessionId, userId },
    select: { title: true, projectId: true },
  });
  if (!session) throw new Error(`Chat not found: ${sessionId}`);

  // A coder chat owns a checkout. When git will not let it go, the chat stays:
  // nothing half-deleted, and the work is still where it was.
  if (session.projectId) await removeChatWorktree(userId, sessionId, force);

  const messages = await prisma.chatMessage.findMany({
    where: { sessionId, session: { userId } },
    include: { attachments: true },
  });
  const storagePaths = messages.flatMap((m) => m.attachments.map((a) => a.storagePath));

  // Files first: a failure here leaves the DB intact for a retry.
  if (storagePaths.length > 0) {
    await deleteAllImages(userId, storagePaths);
  }

  // The cascade removes the watcher rows, but their tick schedulers are BullMQ
  // state the database cannot reach. collect the ids before, unschedule after.
  const watcherIds = await prisma.scriptWatcher
    .findMany({ where: { sessionId, userId }, select: { id: true } })
    .then((watchers) => watchers.map((watcher) => watcher.id));

  // `userId` in the where clause as defense in depth, even though ownership was
  // already checked above.
  await prisma.chatSession.deleteMany({ where: { id: sessionId, userId } });

  for (const watcherId of watcherIds) {
    await unscheduleWatcher(watcherId);
  }

  // Dispose the pooled agent, then remove Pi's JSONL transcript directory.
  await remove(getPoolKey(userId, sessionId));
  try {
    await fs.rm(getSessionDir(userId, sessionId), { recursive: true, force: true });
  } catch (err) {
    console.error(`Failed to clean up session files for ${sessionId}:`, err);
  }

  return { title: session.title };
}

/**
 * Delete several of a user's chats.
 *
 * A chat that cannot be removed (an id from another account, a file that will
 * not unlink) must not abort the batch. the caller gets back what went and
 * what did not, so it can leave the failures selected for a retry.
 */
export async function deleteChatSessions(
  userId: string,
  sessionIds: string[],
  force: boolean = false,
): Promise<BulkDeleteResult> {
  const deleted: string[] = [];
  const failed: BulkDeleteResult["failed"] = [];

  // A repeated id would report a "not found" failure on its second pass.
  for (const sessionId of new Set(sessionIds)) {
    try {
      await deleteChatSession(userId, sessionId, force);
      deleted.push(sessionId);
    } catch (err) {
      console.error(`Failed to delete chat session ${sessionId}:`, err);
      failed.push({
        sessionId,
        error: err instanceof Error ? err.message : String(err),
        ...(err instanceof CoderCleanupError && err.code ? { code: err.code } : {}),
      });
    }
  }

  return { deleted, failed };
}

/**
 * Delete a chat on its way out of the browser, but only one nothing has
 * happened in: a "new chat" the user abandoned, or a temporary chat.
 *
 * The request comes from a `sendBeacon` on unmount/`pagehide`, so it carries a
 * client-side guess about the chat being empty. That guess is not good enough
 * for a delete: a coder chat whose workspace is being built (minutes, before
 * the run is even registered as active) looks idle from the browser, and
 * removing it while `ensureWorktree` is installing would throw the whole chat
 * away. Hence the check against the server's own state before anything is
 * deleted.
 */
export async function autoDeleteChatSession(
  userId: string,
  sessionId: string,
): Promise<AutoDeleteResult> {
  const session = await prisma.chatSession.findFirst({
    where: { id: sessionId, userId },
    select: { temporary: true, _count: { select: { messages: true } } },
  });
  if (!session) return { deleted: false, kept: "missing" };

  const [running, provisioning] = await Promise.all([
    isSessionActive(userId, sessionId),
    getProvisioning(sessionId).then((state) => state !== null),
  ]);

  const kept = keepAutoDeletedSession({
    temporary: session.temporary,
    messageCount: session._count.messages,
    running,
    provisioning,
  });
  if (kept) return { deleted: false, kept };

  await deleteChatSession(userId, sessionId);
  return { deleted: true };
}
