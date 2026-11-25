/**
 * The durable side of "a run is in flight".
 *
 * Redis carries a run's liveness, which is what every connection and every
 * process reads (`registerActiveSession`). It cannot say which run died. far
 * less survive the restart that took it, or a flush of the keyspace. So each run
 * also writes a row, and the recovery pass (`resume-interrupted-runs.ts`)
 * resumes what a restart left behind.
 *
 * The row is written when a run claims its prompt and deleted once the run's
 * reply is saved. A row therefore means exactly one thing: nobody settled this
 * run. Its heartbeat tells the other half apart: a row a process is still
 * refreshing belongs to a live run somewhere, and one nobody refreshed is the
 * leftover a restart made.
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
  /** Last time the owning process said it was still working on this run. */
  heartbeatAt: Date;
}

/**
 * How long a heartbeat stays believable.
 *
 * The owner refreshes it every `ACTIVE_SESSION_HEARTBEAT_MS` (10s), so two
 * missed beats mean the process is gone, or was never running it. Younger than
 * this the row is left alone: it is either live or just claimed by a recovery
 * pass that is still building its agent.
 */
export const RUN_HEARTBEAT_STALE_MS = 20_000;

/** Whether a run's record has gone cold (nobody is refreshing it). */
export function isRunHeartbeatStale(run: InflightChatRun, now: number = Date.now()): boolean {
  return now - run.heartbeatAt.getTime() > RUN_HEARTBEAT_STALE_MS;
}

/** Record that this chat's prompt is now being run. */
export async function markChatRunInFlight(run: {
  sessionId: string;
  userId: string;
  messageId: string;
}): Promise<void> {
  const now = new Date();
  try {
    await prisma.chatRun.upsert({
      where: { sessionId: run.sessionId },
      create: {
        sessionId: run.sessionId,
        userId: run.userId,
        messageId: run.messageId,
        heartbeatAt: now,
      },
      update: { messageId: run.messageId, startedAt: now, heartbeatAt: now },
    });
  } catch (err) {
    console.error(`Failed to record the run in flight for chat ${run.sessionId}:`, err);
  }
}

/** Say the run is still being worked on. Called on the session's heartbeat. */
export async function touchChatRun(sessionId: string): Promise<void> {
  try {
    await prisma.chatRun.updateMany({
      where: { sessionId },
      data: { heartbeatAt: new Date() },
    });
  } catch (err) {
    console.error(`Failed to refresh the run record of chat ${sessionId}:`, err);
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
 * drift. a flag cleared without the record would leave the recovery pass
 * resuming a run the user already watched finish, and a record left behind
 * would resume a run that failed.
 *
 * The tracked saves of the run must be done before this: a record that
 * disappears before the reply it was answering is written turns a finished run
 * into an unanswered message.
 */
export async function endChatRun(userId: string, sessionId: string): Promise<void> {
  await Promise.all([unregisterActiveSession(userId, sessionId), clearChatRun(userId, sessionId)]);
}

/** Every run nobody settled, oldest first. */
export async function listInterruptedChatRuns(): Promise<InflightChatRun[]> {
  try {
    return await prisma.chatRun.findMany({
      orderBy: { startedAt: "asc" },
      select: {
        sessionId: true,
        userId: true,
        messageId: true,
        startedAt: true,
        heartbeatAt: true,
      },
    });
  } catch (err) {
    console.error("Failed to read the runs left in flight:", err);
    return [];
  }
}

/** The chat's unsettled run, or null when it has none. */
export async function getChatRun(sessionId: string): Promise<InflightChatRun | null> {
  try {
    return await prisma.chatRun.findUnique({
      where: { sessionId },
      select: {
        sessionId: true,
        userId: true,
        messageId: true,
        startedAt: true,
        heartbeatAt: true,
      },
    });
  } catch (err) {
    console.error(`Failed to read the run record of chat ${sessionId}:`, err);
    return null;
  }
}

/**
 * Take a run for resuming, or report that somebody else did.
 *
 * Rewriting the heartbeat is the claim: the update only matches the value this
 * caller read, so exactly one of two processes booting together can take the
 * row. The row stays. a resumed run that dies before it can settle is still
 * the run a later pass resumes.
 */
export async function claimInterruptedChatRun(run: InflightChatRun): Promise<boolean> {
  try {
    const claimed = await prisma.chatRun.updateMany({
      where: {
        sessionId: run.sessionId,
        userId: run.userId,
        heartbeatAt: run.heartbeatAt,
      },
      data: { heartbeatAt: new Date() },
    });
    return claimed.count > 0;
  } catch (err) {
    console.error(`Failed to claim the interrupted run of chat ${run.sessionId}:`, err);
    return false;
  }
}

/**
 * Drop a record that will never be resumed: an answered run, a stopped one, one
 * a later message overtook.
 *
 * Matched on the whole record, so this can never take a row a new run wrote in
 * the meantime. that run is the chat's current one, and its record has to
 * survive.
 */
export async function dropInterruptedChatRun(run: InflightChatRun): Promise<void> {
  try {
    await prisma.chatRun.deleteMany({
      where: {
        sessionId: run.sessionId,
        userId: run.userId,
        messageId: run.messageId,
        heartbeatAt: run.heartbeatAt,
      },
    });
  } catch (err) {
    console.error(`Failed to drop the run record of chat ${run.sessionId}:`, err);
  }
}
