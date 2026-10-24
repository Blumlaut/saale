/**
 * What happens to a bot chat once its run is over.
 *
 * A `per-fire` chat exists for one fire. Once its branch is pushed and its tree
 * is clean, the checkout is a copy of work git already has, so the chat is
 * removed after the watcher's retention window. Anything dirty or unpushed is
 * simply kept: the work in it is the reason it is still there, and it reads as
 * an ordinary chat in the project list until someone deals with it.
 *
 * Removal goes through `deleteChatSession`, which asks git first
 * (`removeChatWorktree`) and refuses a dirty checkout on its own. The push check
 * here is the other half: git will happily remove a clean tree whose commits
 * exist nowhere else.
 */

import { prisma } from "@/lib/db";
import { deleteChatSession } from "@/lib/chat/delete-session";
import { isBranchPushed, readStatus } from "@/lib/coder/git";
import { workspaceDirectoryExists } from "@/lib/coder/paths";
import { CoderCleanupError } from "@/lib/coder/worktree-removal";
import { getActiveSessions } from "@/lib/redis";

/** What one pass over the bot chats did. */
export interface WatcherChatSweep {
  removed: string[];
  /** Chats left alone: still busy, still dirty, or with commits nowhere else. */
  kept: number;
}

/** Whether a chat's worktree is safe to remove: clean, and pushed. */
async function holdsFinishedWork(options: {
  userId: string;
  worktree: { path: string; branch: string };
}): Promise<boolean> {
  const { userId, worktree } = options;
  if (!(await workspaceDirectoryExists(userId, worktree.path))) return true;

  const status = await readStatus(userId, worktree.path);
  if (status.files.length > 0) return false;

  return isBranchPushed(userId, worktree.path, worktree.branch);
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
      select: { id: true, coderWorktree: { select: { path: true, branch: true, status: true } } },
    });
    if (chats.length === 0) continue;

    const generating = await getActiveSessions(watcher.userId);

    for (const chat of chats) {
      if (generating.has(chat.id)) {
        kept += 1;
        continue;
      }

      try {
        const worktree = chat.coderWorktree;
        if (worktree && worktree.status === "active") {
          const finished = await holdsFinishedWork({ userId: watcher.userId, worktree });
          if (!finished) {
            kept += 1;
            continue;
          }
        }

        await deleteChatSession(watcher.userId, chat.id);
        removed.push(chat.id);
      } catch (err) {
        // A dirty checkout, an unreachable sandbox, a git that would not answer:
        // all of them leave the chat where it is, with its work.
        const refusal = err instanceof CoderCleanupError;
        if (!refusal) {
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
