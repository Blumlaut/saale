/**
 * The durable side of "a run is in flight".
 *
 * Redis carries a run's liveness, which is what every connection and every
 * process reads (`registerActiveSession`). It cannot say which run died, and a
 * full restart takes it with the process: nothing is left to find. So each run
 * also writes a row, and the boot pass (`resume-interrupted-runs.ts`) resumes
 * what a restart left behind.
 *
 * The row is written when a run claims its prompt and deleted when the run is
 * over, however it ends. A row therefore means exactly one thing: nobody
 * settled this run.
 */

import { prisma } from "@/lib/db";
import { unregisterActiveSession } from "@/lib/redis";

/** A run that has claimed a chat's prompt. */
export interface InflightChatRun {
  sessionId: string;
  userId: string;
  /** The user message the run is answering. */
  messageId: string;
  startedAt: Date;
}

/** Record that this chat's prompt is now being run. */
export async function markChatRunInFlight(run: {
  sessionId: string;
  userId: string;
  messageId: string;
}): Promise<void> {
  try {
    await prisma.chatRun.upsert({
      where: { sessionId: run.sessionId },
      create: { sessionId: run.sessionId, userId: run.userId, messageId: run.messageId },
      update: { messageId: run.messageId, startedAt: new Date() },
    });
  } catch (err) {
    console.error(`Failed to record the run in flight for chat ${run.sessionId}:`, err);
  }
}

async function clearChatRun(userId: string, sessionId: string): Promise<void> {
  try {
    await prisma.chatRun.deleteMany({ where: { sessionId, userId } });
  } catch (err) {
    console.error(`Failed to clear the run record for chat ${sessionId}:`, err);
  }
}

/**
 * The run is over: drop its record and its liveness flag together.
 *
 * Every "this run is finished" path goes through here so the two stores cannot
 * drift. a flag cleared without the record would leave the boot pass resuming a
 * run the user already watched finish, and a record left behind would resume a
 * run that failed.
 */
export async function endChatRun(userId: string, sessionId: string): Promise<void> {
  await Promise.all([unregisterActiveSession(userId, sessionId), clearChatRun(userId, sessionId)]);
}

/** Every run nobody settled, oldest first. */
export async function listInterruptedChatRuns(): Promise<InflightChatRun[]> {
  try {
    return await prisma.chatRun.findMany({
      orderBy: { startedAt: "asc" },
      select: { sessionId: true, userId: true, messageId: true, startedAt: true },
    });
  } catch (err) {
    console.error("Failed to read the runs left in flight:", err);
    return [];
  }
}

/**
 * Take a run's record for resuming, or report that somebody else did.
 *
 * Deleting the row is the claim: exactly one caller can delete it, so two
 * processes booting together cannot both resume the same chat. The winner
 * rewrites the record as soon as its own run is claimed. Matching `startedAt`
 * keeps the claim off a record a fresh run wrote in the meantime.
 */
export async function claimInterruptedChatRun(run: InflightChatRun): Promise<boolean> {
  try {
    const claimed = await prisma.chatRun.deleteMany({
      where: { sessionId: run.sessionId, userId: run.userId, startedAt: run.startedAt },
    });
    return claimed.count > 0;
  } catch (err) {
    console.error(`Failed to claim the interrupted run of chat ${run.sessionId}:`, err);
    return false;
  }
}
