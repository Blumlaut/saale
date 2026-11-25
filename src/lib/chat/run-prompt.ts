/**
 * One chat run: claim the chat's agent, hand it the message, and deliver
 * whatever the user queued behind it. No connection involved.
 *
 * Three callers run a chat without owning a client request: the SSE route, for
 * the message a POST claimed, for a run it recovers and for every run it drains
 * from the queue; the boot pass, which resumes the runs a restart killed
 * (`resume-interrupted-runs.ts`); and `chat_respond`, for a message an agent
 * posts into another chat. All of them have to build, claim and persist
 * identically. a step missing on one shows up as a run that never reaches the
 * DB, a duplicate prompt in the transcript, or a generation Stop cannot find.
 */

import { claimNextQueuedMessage, publishQueueUpdate, restoreQueuedMessage } from "@/lib/chat/queue";
import { drainSendQueue } from "@/lib/chat/drain-queue";
import { RUN_HEARTBEAT_STALE_MS, touchChatRun } from "@/lib/chat/run-record";
import { readImageAsBase64 } from "@/lib/image-attachment";
import { get as getPoolEntry, getPoolKey } from "@/lib/pi/agent-pool";
import type { ChatSessionModelConfig } from "@/lib/pi/chat-session-factory";
import {
  answerOrphanedCalls,
  applyInterruptedTurn,
  orphanedCallsOnBranch,
  planInterruptedTurn,
} from "@/lib/pi/interrupted-turn";
import type { ImageContent } from "@/lib/pi/message-replay";
import { applyPendingHistoryRewind, rewindDuplicatePrompt } from "@/lib/pi/message-rewind";
import { isSendQueueHeld } from "@/lib/redis";
import { chatUsageKind } from "@/lib/usage/record";
import {
  beginChatRun,
  dispatchChatRun,
  ensureChatAgent,
  type ChatRunLog,
  type ChatRunMode,
  type PooledChatSession,
} from "./agent-run";

/** A message this run can hand to the agent. */
export interface ChatPromptTarget {
  id: string;
  content: string;
  attachments: { storagePath: string; mimeType: string }[];
}

/** A claimed chat, waiting to be handed its run. */
export interface PreparedChatRun {
  entry: PooledChatSession;
  target: ChatPromptTarget;
  /**
   * `continue` picks up the turn the transcript already holds (a run a restart
   * cut off); `prompt` sends the message.
   */
  mode: ChatRunMode;
  images: ImageContent[];
}

/** The chat a run belongs to: what building its agent and billing the run read. */
export interface ChatRunSession extends ChatSessionModelConfig {
  id: string;
  origin: string;
}

/**
 * Collect vision content for a message's image attachments. Non-image files are
 * referenced by path in the message content instead (the agent reads them from
 * its workspace).
 */
async function loadPromptImages(
  userId: string,
  attachments: ChatPromptTarget["attachments"],
): Promise<ImageContent[]> {
  const images: ImageContent[] = [];
  for (const att of attachments) {
    if (!att.mimeType.startsWith("image/")) continue;
    try {
      const { data, mimeType } = await readImageAsBase64(userId, att.storagePath);
      images.push({ type: "image" as const, data, mimeType });
    } catch (err) {
      console.error("Failed to load image for message:", err);
    }
  }
  return images;
}

/**
 * Claim this process's pooled agent for a message and make it runnable: guard
 * against a double prompt, put the transcript in the state the run needs,
 * register the generation, and pre-load images.
 *
 * Returns `busy` when a prompt is already in flight in this process: the caller
 * must not claim work it cannot deliver.
 */
export async function prepareChatRun(options: {
  userId: string;
  chatSession: ChatRunSession;
  /** Resolved model; the chat's own, or the user's default when omitted. */
  model?: { provider: string; name: string } | undefined;
  target: ChatPromptTarget;
  /**
   * This message's run was interrupted, so its turn may already be in the
   * transcript. Continue it there when it can be, instead of sending the
   * message again.
   */
  resume?: boolean | undefined;
  log?: ChatRunLog | undefined;
}): Promise<PreparedChatRun | null> {
  const { userId, chatSession, target, log } = options;

  // Building an agent is slow (a coder chat checks out a worktree, fetches and
  // installs: minutes), and nothing else refreshes the run record meanwhile. A
  // resumed run that stopped saying so would look dead to another process, which
  // would start the same turn over the same transcript.
  const keepClaimFresh = options.resume ? startClaimHeartbeat(chatSession.id) : null;
  let claimed: { entry: PooledChatSession; existedAlready: boolean };
  try {
    claimed = await ensureChatAgent({
      userId,
      sessionId: chatSession.id,
      chatSession,
      ...(options.model ? { model: options.model } : {}),
      log,
    });
  } finally {
    keepClaimFresh?.();
  }
  const { entry, existedAlready } = claimed;

  if (existedAlready) {
    log?.("pool", `hit. lastPromptedMessageId=${entry.lastPromptedMessageId}`);
  }

  // Same-process double-prompt guard (recovery path race).
  if (entry.promptInFlight) return null;

  // Claim synchronously before any further awaits.
  entry.promptInFlight = true;
  entry.lastPromptedMessageId = target.id;

  try {
    const mode = await prepareTranscript({
      sessionId: chatSession.id,
      entry,
      target,
      resume: options.resume === true,
      log,
    });

    // Publish the generation, record it for the recovery pass, clear stale
    // buffered events, and wire DB persistence.
    await beginChatRun({
      userId,
      sessionId: chatSession.id,
      session: entry.session,
      usageKind: chatUsageKind(chatSession),
      messageId: target.id,
    });

    // A continued turn already carries its message's images.
    const images = mode === "prompt" ? await loadPromptImages(userId, target.attachments) : [];
    log?.("prompt", `claimed ${mode} for message ${target.id}`);
    return { entry, target, mode, images };
  } catch (err) {
    // Nothing was dispatched, so nothing will settle and release the chat. a
    // stuck `promptInFlight` would 409 every message the chat gets after this.
    entry.promptInFlight = false;
    entry.lastPromptedMessageId = null;
    throw err;
  }
}

/**
 * Keep a claimed run's record fresh until the run itself takes over.
 *
 * @returns a function that stops the heartbeat.
 */
function startClaimHeartbeat(sessionId: string): () => void {
  const timer = setInterval(() => {
    touchChatRun(sessionId).catch((err) => {
      console.error(`Failed to refresh the claimed run of chat ${sessionId}:`, err);
    });
  }, RUN_HEARTBEAT_STALE_MS / 2);
  timer.unref?.();
  return () => clearInterval(timer);
}

/**
 * Put the agent's transcript in the state this run needs.
 *
 * @returns whether the run continues the turn already in the transcript.
 */
async function prepareTranscript(options: {
  sessionId: string;
  entry: PooledChatSession;
  target: ChatPromptTarget;
  resume: boolean;
  log: ChatRunLog | undefined;
}): Promise<ChatRunMode> {
  const { sessionId, entry, target, resume, log } = options;
  if (resume) {
    const plan = planInterruptedTurn(entry.session, { content: target.content });
    if (await applyInterruptedTurn(entry.session, plan)) {
      log?.("resume", `continuing the interrupted turn of message ${target.id}`);
      return "continue";
    }
    log?.("resume", `the transcript has no turn to continue (${plan.kind})`);
  }

  // A run that died mid-flight (restart, crash) left its prompt in the
  // transcript with no reply, and this prompt is about to replace it: rewind
  // first so the message is not appended twice (see message-rewind.ts).
  if (await rewindDuplicatePrompt(entry.session, { content: target.content })) {
    log?.("rewind", `transcript already held message ${target.id}. rewound before it`);
  }

  // An edited message still has the history its edit deleted in the agent
  // transcript. rewind it, or the prompt lands as a brand new message after
  // the old conversation (see message-rewind.ts).
  const rewind = await applyPendingHistoryRewind(sessionId, entry.session, target.id);
  if (rewind !== "nothing-pending") {
    log?.("rewind", `${rewind} for message ${target.id}`);
  }

  // A run that died mid-tool leaves a call with no result on the branch, and the
  // message about to be sent would answer a tool call. whatever got us here.
  const orphaned = orphanedCallsOnBranch(entry.session);
  if (orphaned.length > 0) {
    log?.("resume", `answering ${orphaned.length} call(s) a dead run left open`);
    answerOrphanedCalls(entry.session, orphaned);
  }

  return "prompt";
}

/**
 * Hand a prepared run to the agent and resolve once it has fully settled
 * (`agent_settled`. after any error retry, auto-compaction, or queued
 * continuation). Returns false when the run failed.
 */
export async function dispatchPreparedChatRun(options: {
  userId: string;
  chatSession: ChatRunSession;
  run: PreparedChatRun;
  log?: ChatRunLog | undefined;
  /** Runs after a failed run was ended and published. */
  onRunFailed?: ((error: unknown) => void) | undefined;
}): Promise<boolean> {
  return dispatchChatRun({
    userId: options.userId,
    sessionId: options.chatSession.id,
    entry: options.run.entry,
    content: options.run.target.content,
    mode: options.run.mode,
    images: options.run.images,
    log: options.log,
    onRunFailed: options.onRunFailed,
  });
}

/**
 * Deliver every message the user queued behind the chat's current run, one run
 * each, and never throw: the callers are fire-and-forget (a settled run, an idle
 * connection, the boot pass) and an unhandled rejection has nowhere to surface.
 *
 * Runs server-side, so queued messages are answered even when every client has
 * navigated away.
 */
export function createChatQueueDrain(options: {
  userId: string;
  chatSession: ChatRunSession;
  model?: { provider: string; name: string } | undefined;
  log?: ChatRunLog | undefined;
  onRunFailed?: ((error: unknown) => void) | undefined;
}): () => void {
  const { userId, chatSession } = options;
  const poolKey = getPoolKey(userId, chatSession.id);

  return () => {
    drainSendQueue({
      isPromptInFlight: () => getPoolEntry(poolKey)?.promptInFlight === true,
      // A stopped session does not send: the hold is released by the user's
      // next message or by pushing a queued one.
      claimNext: async () =>
        (await isSendQueueHeld(chatSession.id)) ? null : claimNextQueuedMessage(chatSession.id),
      run: async (message) => {
        let prepared: PreparedChatRun | null;
        try {
          prepared = await prepareChatRun({
            userId,
            chatSession,
            model: options.model,
            target: { id: message.id, content: message.content, attachments: message.attachments },
            log: options.log,
          });
        } catch (err) {
          console.error(`Failed to prepare queued message ${message.id}:`, err);
          return false;
        }
        if (!prepared) return false;
        options.log?.("queue", `delivering queued message ${message.id}`);
        await dispatchPreparedChatRun({
          userId,
          chatSession,
          run: prepared,
          log: options.log,
          onRunFailed: options.onRunFailed,
        });
        return true;
      },
      restore: (message) => restoreQueuedMessage(chatSession.id, message.id, message.queuedAt),
      publishQueue: () => publishQueueUpdate(chatSession.id),
      log: (message) => options.log?.("queue", message),
    }).catch((err) => {
      console.error(`Send queue drain failed for session ${chatSession.id}:`, err);
    });
  };
}
