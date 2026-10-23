/**
 * Deleting a chat. shared by the delete route (the sidebar action, the
 * sendBeacon on tab close) and the `chat_delete` tool, so a chat removed by an
 * agent is cleaned up exactly like one removed from the UI.
 *
 * Order of operations:
 * 1. Verify ownership (`userId` in the query. an id-only delete would let a
 *    guessed id remove another user's chat)
 * 2. For a coder chat, remove its worktree. git refuses a dirty checkout, and
 *    that refusal aborts the delete, so the chat never outlives its work
 * 3. Delete attachment files from disk (fails fast, leaving the DB intact)
 * 4. Delete the session row (cascade removes messages + attachment records +
 *    watcher rows)
 * 5. Unschedule the chat's watchers (the cascade cannot reach BullMQ state)
 * 6. Release the pooled agent and Pi's transcript directory
 */

import fs from "fs/promises";
import { prisma } from "@/lib/db";
import { deleteAllImages } from "@/lib/image-attachment";
import { unscheduleWatcher } from "@/lib/queue";
import { getPoolKey, getSessionDir, remove } from "@/lib/pi/agent-pool";
import { removeChatWorktree } from "@/lib/coder/worktree-removal";

/** The deleted chat's title, for a confirmation message. */
export interface DeletedChat {
  title: string;
}

/** Outcome of a multi-chat delete: what went, and what is still there. */
export interface BulkDeleteResult {
  deleted: string[];
  failed: Array<{ sessionId: string; error: string }>;
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
      failed.push({ sessionId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return { deleted, failed };
}
