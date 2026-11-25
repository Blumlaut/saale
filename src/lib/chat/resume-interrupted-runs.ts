/**
 * Pick up the chat runs a restart killed.
 *
 * A chat's agent lives in the web process, so a restart (a deploy, a crash, a
 * reboot) ends every run in flight: the answer stops mid-sentence, the client
 * waits on a stream nothing will ever write to, and the user's message sits
 * unanswered until they notice and ask again.
 *
 * Which runs died is the `ChatRun` record's job (see run-record.ts): it exists
 * only while a run is unsettled, and its heartbeat is refreshed by the process
 * working on it. A record nobody is refreshing is exactly what a restart
 * leaves behind. The checks below keep a run that is still alive somewhere out
 * of the pass: its heartbeat is fresh, its liveness flag is set, or its message
 * already has the answer that ended it.
 *
 * Resuming continues the turn the transcript still holds, so the model reads the
 * calls whose results never arrived (see interrupted-turn.ts) and carries on from
 * there. The partial answer that was streaming is gone. the DB only ever held
 * finished turns.
 *
 * A resumed turn is at-least-once, like any re-run: a tool the restart killed
 * may have to run again, which is what the note tells the model to watch for.
 *
 * This is the second of the two ways back to an interrupted run. The first is
 * the user's own reconnect, which the stream route decides on (see
 * `decideStreamAction`): this pass is for the chats nobody came back to, and it
 * sweeps on an interval so a run a failed resume left behind is not stranded
 * either.
 */

import { prisma } from "@/lib/db";
import { isSendQueueHeld, isSessionActive } from "@/lib/redis";
import { hasFinalAnswer } from "@/lib/chat/run-answer";
import {
  claimInterruptedChatRun,
  dropInterruptedChatRun,
  endChatRun,
  isRunHeartbeatStale,
  listInterruptedChatRuns,
  type InflightChatRun,
} from "@/lib/chat/run-record";
import type { ChatRunLog } from "@/lib/chat/agent-run";

/**
 * How long after boot to look.
 *
 * The rest of the stack is still coming up (sandbox, database connections), and
 * a run another process owns only refreshes its liveness every few seconds, for
 * `ACTIVE_SESSION_TTL_SECONDS` at a time. Waiting well past both keeps a resumed
 * run from failing on a service that is not ready, and keeps a live run out of
 * the pass.
 */
const RECOVERY_DELAY_MS = 60_000;

/**
 * How often to look again.
 *
 * A resumed run can die too, and a boot is not the only way a run loses its
 * process (an evicted session, a killed worker). Once a minute is what a chat
 * nobody is watching can wait for without the pass costing anything.
 */
const RECOVERY_SWEEP_MS = 60_000;

/** What the pass did, for the boot log and for tests. */
export interface ChatRecoveryReport {
  /** Chats whose message was picked back up. */
  resumed: string[];
  /** Records that were dropped: the run was answered, stopped or unrecoverable. */
  dropped: string[];
  /** Chats left alone because a run still looks live somewhere. */
  live: string[];
}

/**
 * Resume every run a restart interrupted, one chat at a time.
 *
 * Never throws: a single unrecoverable chat must not take the pass, or the boot,
 * with it.
 */
export async function resumeInterruptedChatRuns(): Promise<ChatRecoveryReport> {
  const report: ChatRecoveryReport = { resumed: [], dropped: [], live: [] };
  const runs = await listInterruptedChatRuns();
  if (runs.length === 0) return report;

  for (const run of runs) {
    try {
      const outcome = await resumeRun(run);
      if (outcome === "resumed") report.resumed.push(run.sessionId);
      else if (outcome === "live") report.live.push(run.sessionId);
      else report.dropped.push(run.sessionId);
    } catch (err) {
      console.error(`Failed to resume the interrupted run of chat ${run.sessionId}:`, err);
    }
  }

  if (report.resumed.length > 0) {
    console.warn(`[chat-recovery] resumed ${report.resumed.length} interrupted chat run(s)`);
  }
  return report;
}

type ResumeOutcome = "resumed" | "dropped" | "live";

async function resumeRun(run: InflightChatRun): Promise<ResumeOutcome> {
  const { sessionId, userId, messageId, startedAt } = run;
  const log: ChatRunLog = (tag, ...args) =>
    // eslint-disable-next-line no-console
    console.log(`[chat-recovery:${sessionId}] ${tag}`, ...args);

  // Someone is still working on it. leave its record exactly as it is.
  if (await isSessionActive(userId, sessionId)) return "live";
  // Or said so a moment ago, before its liveness flag existed (the build a
  // resume starts with takes minutes). Two guesses are one guess too many.
  if (!isRunHeartbeatStale(run)) return "live";

  const chatSession = await prisma.chatSession.findFirst({
    where: { id: sessionId, userId },
    select: {
      id: true,
      origin: true,
      projectId: true,
      modelProvider: true,
      modelName: true,
      thinkingLevel: true,
      toolConfig: true,
    },
  });
  if (!chatSession) return "dropped";

  // The user stopped this chat by hand, so there is nothing to continue.
  if (await isSendQueueHeld(sessionId)) {
    await dropInterruptedChatRun(run);
    return "dropped";
  }

  const target = await prisma.chatMessage.findFirst({
    where: { id: messageId, sessionId },
    include: { attachments: { select: { storagePath: true, mimeType: true } } },
  });
  if (!target || target.role !== "user") {
    await dropInterruptedChatRun(run);
    return "dropped";
  }

  // A later message owns the conversation now: resuming this one would answer
  // it after the newer turn, in the wrong place. The newer run writes its own
  // record, so this one is simply behind the times.
  const newestUserMessage = await prisma.chatMessage.findFirst({
    where: { sessionId, role: "user", queuedAt: null },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  if (newestUserMessage?.id !== target.id) {
    await dropInterruptedChatRun(run);
    return "dropped";
  }

  // A saved answer is a run that did its job: only its record is left over.
  if (await hasFinalAnswer(sessionId, startedAt)) {
    await dropInterruptedChatRun(run);
    return "dropped";
  }

  // Take the run: two processes sweeping together must not both resume.
  if (!(await claimInterruptedChatRun(run))) return "live";

  // Loaded here, not at the top of the file: this pulls in Pi and the whole
  // tool registry, which must not sit in front of the boot's first request.
  const [{ resolveChatModel }, { createChatQueueDrain, dispatchPreparedChatRun, prepareChatRun }] =
    await Promise.all([import("@/lib/pi/chat-session-factory"), import("@/lib/chat/run-prompt")]);

  const model = await resolveChatModel(userId, chatSession);
  if (!model) {
    console.warn(`[chat-recovery:${sessionId}] the chat has no model, nothing to resume with`);
    await endChatRun(userId, sessionId).catch((err) => {
      console.error(`Failed to drop the unresumable run of chat ${sessionId}:`, err);
    });
    return "dropped";
  }

  const prepared = await prepareChatRun({
    userId,
    chatSession,
    model,
    target: { id: target.id, content: target.content, attachments: target.attachments },
    resume: true,
    log,
  });
  // A run claimed this chat in this process while the pass was deciding. It is
  // running, so there is nothing to resume.
  if (!prepared) return "live";

  const settled = await dispatchPreparedChatRun({
    userId,
    chatSession,
    run: prepared,
    log,
  });
  // The queue the user filled during the interrupted run is delivered next.
  createChatQueueDrain({ userId, chatSession, model, log })();
  return settled ? "resumed" : "dropped";
}

/**
 * Run the recovery pass at boot, then keep sweeping.
 *
 * Called by the server's one boot hook (`src/instrumentation.ts`), which is the
 * only thing that knows a new process has started.
 */
export function scheduleInterruptedRunRecovery(): void {
  const sweep = () => {
    void resumeInterruptedChatRuns().catch((err) => {
      console.error("[chat-recovery] the pass failed:", err);
    });
  };

  const first = setTimeout(sweep, RECOVERY_DELAY_MS);
  first.unref?.();
  const interval = setInterval(sweep, RECOVERY_SWEEP_MS);
  interval.unref?.();
}
