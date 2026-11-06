/**
 * Pick up the chat runs a restart killed.
 *
 * A chat's agent lives in the web process, so a restart (a deploy, a crash, a
 * reboot) ends every run in flight: the answer stops mid-sentence, the client
 * waits on a stream nothing will ever write to, and the user's message sits
 * unanswered until they notice and ask again.
 *
 * Which runs died is the `ChatRun` record's job (see run-record.ts): it exists
 * only while a run is in flight, so whatever is left at boot is exactly what the
 * restart interrupted. A run that finished, failed or was stopped cleared its
 * own record, and the two checks below (answered, stopped) keep a run that died
 * on its way out of the door from being resumed twice.
 *
 * Resuming means prompting the user's message again on a freshly built agent:
 * the transcript is replayed from the DB and the Pi session file, and the turn
 * the restart cut off is rewound so the message is not appended twice. The model
 * answers from scratch; the partial answer a reboot swallowed is gone.
 *
 * A resumed turn is at-least-once, like any re-prompt: tools the interrupted
 * turn had already run before it could save a reply run again.
 */

import { prisma } from "@/lib/db";
import { isSessionActive, isSendQueueHeld } from "@/lib/redis";
import {
  claimInterruptedChatRun,
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

/** What the pass did, for the boot log and for tests. */
export interface ChatRecoveryReport {
  /** Chats whose message was prompted again. */
  resumed: string[];
  /** Records that were dropped: the run was answered, stopped or unrecoverable. */
  dropped: string[];
  /** Chats left alone because a run is still live somewhere else. */
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

  // A run that is still alive somewhere (the worker running a Telegram reply)
  // owns this chat. leave its record exactly as it is.
  if (await isSessionActive(userId, sessionId)) return "live";

  // Take the record: two processes booting together must not both resume.
  if (!(await claimInterruptedChatRun(run))) return "dropped";

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
  if (await isSendQueueHeld(sessionId)) return "dropped";

  const target = await prisma.chatMessage.findFirst({
    where: { id: messageId, sessionId },
    include: { attachments: { select: { storagePath: true, mimeType: true } } },
  });
  if (!target || target.role !== "user") return "dropped";

  // Something landed after this run claimed the prompt: the model replied (the
  // run did its job) or began a tool turn (whose side effects already happened).
  // Prompting the message again would repeat both. What the chat held before the
  // claim belongs to earlier runs and does not make this one answered.
  const reply = await prisma.chatMessage.findFirst({
    where: { sessionId, role: "assistant", createdAt: { gt: startedAt } },
    select: { id: true },
  });
  if (reply) return "dropped";

  // Loaded here, not at the top of the file: this pulls in Pi and the whole
  // tool registry, which must not sit in front of the boot's first request.
  const [{ resolveChatModel }, { createChatQueueDrain, dispatchPreparedChatRun, prepareChatRun }] =
    await Promise.all([import("@/lib/pi/chat-session-factory"), import("@/lib/chat/run-prompt")]);

  const model = await resolveChatModel(userId, chatSession);
  if (!model) {
    console.warn(`[chat-recovery:${sessionId}] the chat has no model, nothing to resume with`);
    return "dropped";
  }

  const prepared = await prepareChatRun({
    userId,
    chatSession,
    model,
    target: { id: target.id, content: target.content, attachments: target.attachments },
    log,
  });
  // A run claimed this chat in this process while the pass was deciding. It is
  // running, so there is nothing to resume.
  if (!prepared) return "dropped";

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
 * Run the recovery pass once, a little after boot.
 *
 * Called by the server's one boot hook (`src/instrumentation.ts`), which is the
 * only thing that knows a new process has started.
 */
export function scheduleInterruptedRunRecovery(): void {
  const timer = setTimeout(() => {
    void resumeInterruptedChatRuns().catch((err) => {
      console.error("[chat-recovery] the pass failed:", err);
    });
  }, RECOVERY_DELAY_MS);
  timer.unref?.();
}
