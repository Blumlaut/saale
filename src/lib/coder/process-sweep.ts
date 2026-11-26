/**
 * Killing what outlives its chat.
 *
 * Every command a chat runs carries the chat's id, and a dev server started
 * there keeps running after the chat is deleted, or after a delete that failed
 * halfway. Only the panel can stop those, through the chat it belongs to, and a
 * chat id no row answers to has no panel: this sweep is the last thing that can
 * reach them.
 *
 * A dev env started from the panel, the console or a script button carries no
 * chat id at all, so nothing can name it afterwards. It is what the delete-time
 * sweep is for: it matches a process by the checkout it runs in (see
 * `stopChatProcesses`), before the rows go.
 *
 * Only containers that are already running are swept: a stopped one holds no
 * processes, and starting it to look is work nobody asked for.
 */

import { prisma } from "@/lib/db";
import { userIdentity } from "@/lib/sandbox/identity";
import { listRunningChatIds, stopChatProcessesById } from "./processes";

/** What one process sweep did. */
export interface ProcessSweepResult {
  /** The chat ids whose processes were stopped: no chat row answers to them. */
  stopped: string[];
  /** How many chats still had the processes they are entitled to. */
  live: number;
}

/**
 * Stop the processes of every chat this account no longer has.
 *
 * Called for one user right after a delete, and for every user with a project
 * by the daily pass.
 */
export async function sweepUserOrphanProcesses(userId: string): Promise<ProcessSweepResult> {
  const stopped: string[] = [];
  let live = 0;

  let running: string[];
  try {
    running = await listRunningChatIds(userId);
  } catch (err) {
    console.error(`[coder] failed to list the processes of ${userId}:`, err);
    return { stopped, live };
  }
  if (running.length === 0) return { stopped, live };

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

  if (stopped.length > 0) {
    console.warn(`[coder] stopped what ${stopped.length} deleted chat(s) left running`);
  }
  return { stopped, live };
}

/**
 * Stop the processes of every chat that is gone.
 *
 * Scoped per user: a process is only ever matched against the chats of the
 * account whose container it runs in.
 *
 * @param runningIdentities - Workspaces whose container is running now
 */
export async function sweepOrphanProcesses(
  runningIdentities: ReadonlySet<string>,
): Promise<ProcessSweepResult> {
  const total: ProcessSweepResult = { stopped: [], live: 0 };
  if (runningIdentities.size === 0) return total;

  const projects = await prisma.coderProject.findMany({
    select: { userId: true },
    distinct: ["userId"],
  });

  for (const { userId } of projects) {
    if (!runningIdentities.has(userIdentity(userId))) continue;
    const result = await sweepUserOrphanProcesses(userId);
    total.stopped.push(...result.stopped);
    total.live += result.live;
  }

  return total;
}
