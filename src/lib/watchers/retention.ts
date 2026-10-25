/**
 * What happens to a bot chat once its run is over.
 *
 * A `per-fire` chat exists for one fire. `deleteChatSession` decides whether it
 * may go: it removes the checkout through `removeChatWorktree`, which refuses
 * work that exists nowhere else (a dirty tree, or commits no other ref carries)
 * and takes the branch with it. Anything refused is simply kept, and reads as an
 * ordinary chat in the project list until someone deals with it.
 */

import { prisma } from "@/lib/db";
import { deleteChatSession } from "@/lib/chat/delete-session";
import { CoderCleanupError } from "@/lib/coder/worktree-removal";
import { getActiveSessions } from "@/lib/redis";

/** What one pass over the bot chats did. */
export interface WatcherChatSweep {
  removed: string[];
  /** Chats left alone: still busy, still dirty, or with commits nowhere else. */
  kept: number;
}

/**
 * Remove the per-fire chats whose retention window has passed and whose work is
 * somewhere else.
 *
 * Runs from the worker on a schedule. Never throws for one chat: a checkout git
 * refuses, a missing project, a database blip. all mean "keep it", which is the
 * safe end of every case here.
 */
export async function sweepWatcherChats(): Promise<WatcherChatSweep> {
  const watchers = await prisma.scriptWatcher.findMany({
    where: { deliver: "coder", worktreeMode: "per-fire" },
    select: { id: true, userId: true, name: true, retentionMinutes: true },
  });

  const removed: string[] = [];
  let kept = 0;

  for (const watcher of watchers) {
    const cutoff = new Date(Date.now() - watcher.retentionMinutes * 60_000);
    const chats = await prisma.chatSession.findMany({
      where: {
        userId: watcher.userId,
        origin: "watcher",
        originId: watcher.id,
        lastActivityAt: { lt: cutoff },
      },
      select: { id: true },
    });
    if (chats.length === 0) continue;

    const generating = await getActiveSessions(watcher.userId);

    for (const chat of chats) {
      if (generating.has(chat.id)) {
        kept += 1;
        continue;
      }

      try {
        await deleteChatSession(watcher.userId, chat.id);
        removed.push(chat.id);
      } catch (err) {
        // A checkout kept for the work in it is the expected answer; anything
        // else (an unreachable sandbox, git refusing) means the same here.
        if (!(err instanceof CoderCleanupError)) {
          console.error(
            `[watcher:${watcher.id}] Could not clean up chat ${chat.id}, keeping it:`,
            err,
          );
        }
        kept += 1;
      }
    }
  }

  return { removed, kept };
}
