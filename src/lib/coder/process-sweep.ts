/**
 * Killing what outlives its chat.
 *
 * Every command a chat runs carries the chat's id, and a dev server started
 * there keeps running after the chat is deleted, or after a delete that failed
 * halfway. Only the panel can stop those, through the chat it belongs to, and a
 * chat id no row answers to has no panel: this sweep is the last thing that can
 * reach them.
 *
 * Only users with a coder project are swept. A container is created on a
 * user's first command, and the sweep is not a good reason to make one.
 */

import { prisma } from "@/lib/db";
import { canExec } from "@/lib/sandbox/client";
import { listRunningChatIds, stopChatProcessesById } from "./processes";

/** What one process sweep did. */
export interface ProcessSweepResult {
  /** The chat ids whose processes were stopped: no chat row answers to them. */
  stopped: string[];
  /** How many chats still had the processes they are entitled to. */
  live: number;
}

/**
 * Stop the processes of every chat that is gone.
 *
 * Scoped per user: a process is only ever matched against the chats of the
 * account whose container it runs in.
 */
export async function sweepOrphanProcesses(): Promise<ProcessSweepResult> {
  const stopped: string[] = [];
  let live = 0;
  if (!canExec()) return { stopped, live };

  const projects = await prisma.coderProject.findMany({
    select: { userId: true },
    distinct: ["userId"],
  });

  for (const { userId } of projects) {
    let running: string[];
    try {
      running = await listRunningChatIds(userId);
    } catch (err) {
      console.error(`[coder] failed to list the processes of ${userId}:`, err);
      continue;
    }
    if (running.length === 0) continue;

    const owned = await prisma.chatSession.findMany({
      where: { userId, id: { in: running } },
      select: { id: true },
    });
    const existing = new Set(owned.map((chat) => chat.id));
    live += existing.size;

    for (const chatId of running) {
      if (existing.has(chatId)) continue;
      try {
        await stopChatProcessesById(userId, chatId);
        stopped.push(chatId);
      } catch (err) {
        console.error(`[coder] failed to stop the processes of chat ${chatId}:`, err);
      }
    }
  }

  if (stopped.length > 0) {
    console.warn(`[coder] stopped what ${stopped.length} deleted chat(s) left running`);
  }
  return { stopped, live };
}
