/**
 * `chat_respond`: post a message into another chat as the user, run that
 * chat's agent, and return its reply.
 *
 * This is a full agent run in the target chat. not a plain insert. so an
 * assistant can hold a conversation with itself across chats (hand work to
 * another conversation, leave an answer there, keep a long thread going).
 *
 * Guards worth knowing about:
 * - the target chat must belong to the user, and must not be the caller's own
 *   chat (a session cannot be prompted while it is already running);
 * - a busy target is refused rather than queued. the caller is waiting for a
 *   reply, and two runs over one transcript would fight over it. Because the
 *   caller's own session is registered active for the whole run, this also
 *   makes cross-chat loops (A → B → A) impossible.
 *
 * The target's own approval cards are published on the target's session bus,
 * so a tool it wants to run with an `ask` policy is confirmed by whoever is
 * watching that chat. the caller only sees the outcome (a denial becomes part
 * of the reply).
 */

import { prisma } from "@/lib/db";
import { isSessionActive, unregisterActiveSession } from "@/lib/redis";
import { get as getPoolEntry, getPoolKey } from "@/lib/pi/agent-pool";
import { resolveChatModel } from "@/lib/pi/chat-session-factory";
import { publishSessionEvent } from "@/lib/pi/session-events";
import { waitForPersistenceTeardown } from "@/lib/pi/session-persistence";
import { beginChatRun, dispatchChatRun, ensureChatAgent } from "./agent-run";

export interface RespondInChatOptions {
  userId: string;
  /** The chat to post into. */
  sessionId: string;
  /** The caller's own chat. it may not answer itself. */
  callerSessionId?: string | null;
  /** The message to post as the user. */
  message: string;
  /** The caller's run signal; aborting the caller aborts this run too. */
  signal?: AbortSignal | undefined;
}

export interface RespondInChatResult {
  sessionId: string;
  title: string;
  /** The turn's reply; empty when the run produced no text. */
  reply: string;
  /**
   * Whether the run left an assistant turn at all.
   *
   * A run can settle with nothing in the transcript: a provider failure the SDK
   * retried away, or a turn whose whole attempt was discarded. A caller that
   * needs an answer, a watcher fire among them, gets to tell that apart from an
   * empty one.
   */
  answered: boolean;
  /** The provider error the turn ended with, when it ended in one. */
  error: string | null;
}

export async function respondInChat(options: RespondInChatOptions): Promise<RespondInChatResult> {
  const { userId } = options;
  const message = options.message.trim();
  if (!message) throw new Error("message must not be empty");
  if (options.callerSessionId && options.callerSessionId === options.sessionId) {
    throw new Error("A chat cannot respond to itself. post into a different chat");
  }

  const chatSession = await prisma.chatSession.findFirst({
    where: { id: options.sessionId, userId },
  });
  if (!chatSession) throw new Error(`Chat not found: ${options.sessionId}`);

  const model = await resolveChatModel(userId, chatSession);
  if (!model) throw new Error(`Chat "${chatSession.title}" has no model configured`);

  await assertIdle(userId, chatSession.id, chatSession.title);

  const { entry } = await ensureChatAgent({
    userId,
    sessionId: chatSession.id,
    chatSession,
    model,
  });

  // Another process may have started a run between the check and the pool
  // lookup; the pool entry's own flag is the authoritative same-process guard.
  // Claim before writing anything, so a refused call leaves no stray message.
  if (entry.promptInFlight) {
    throw new Error(`Chat "${chatSession.title}" is busy. try again once it is idle`);
  }
  entry.promptInFlight = true;

  let settled = false;
  let promptedAt: Date | null = null;
  const detachAbort = attachAbort(options.signal, entry.session);
  try {
    const userMessage = await prisma.chatMessage.create({
      data: { sessionId: chatSession.id, role: "user", content: message },
    });
    promptedAt = userMessage.createdAt;
    await prisma.chatSession.update({
      where: { id: chatSession.id },
      data: { lastActivityAt: new Date(), messageCount: { increment: 1 } },
    });
    entry.lastPromptedMessageId = userMessage.id;

    await beginChatRun({ userId, sessionId: chatSession.id, session: entry.session });

    // Let any client that has this chat open show the posted message right
    // away; the assistant's reply streams through the same bus as it arrives.
    await publishSessionEvent(chatSession.id, "messages_changed", {}).catch((err) => {
      console.error(`Failed to publish message change for chat ${chatSession.id}:`, err);
    });

    settled = await dispatchChatRun({
      userId,
      sessionId: chatSession.id,
      entry,
      content: message,
    });
  } finally {
    detachAbort();
    // A failure before the agent was prompted (abort, Redis down) still has to
    // release the claim, or this chat would look busy until pool eviction.
    if (!settled) {
      entry.promptInFlight = false;
      entry.lastPromptedMessageId = null;
      await unregisterActiveSession(userId, chatSession.id).catch((err) => {
        console.error(`Failed to unregister ${chatSession.id} after a failed run:`, err);
      });
    }
  }

  if (!settled) throw new Error(`Chat "${chatSession.title}" failed to respond`);

  // The tracker publishes `done` only after its pending DB writes settle, so
  // waiting for teardown guarantees the turn is readable below.
  await waitForPersistenceTeardown(chatSession.id);

  const turn = await prisma.chatMessage.findFirst({
    where: {
      sessionId: chatSession.id,
      role: "assistant",
      ...(promptedAt ? { createdAt: { gte: promptedAt } } : {}),
    },
    orderBy: { createdAt: "desc" },
    select: { content: true, errorMessage: true },
  });

  return {
    sessionId: chatSession.id,
    title: chatSession.title,
    reply: turn?.content ?? "",
    answered: turn !== null,
    error: turn?.errorMessage ?? null,
  };
}

/** Refuse a chat that is already generating. */
async function assertIdle(userId: string, sessionId: string, title: string): Promise<void> {
  const pooled = getPoolEntry(getPoolKey(userId, sessionId));
  if (pooled?.promptInFlight || pooled?.session.isStreaming === true) {
    throw new Error(`Chat "${title}" is busy. try again once it is idle`);
  }
  if (await isSessionActive(userId, sessionId)) {
    throw new Error(`Chat "${title}" is busy. try again once it is idle`);
  }
}

/**
 * Abort the target's run when the caller's run is stopped.
 *
 * Returns a detach function. The parent's Stop must reach this run too:
 * otherwise the reply lands minutes after the user thought they cancelled.
 */
function attachAbort(
  signal: AbortSignal | undefined,
  session: { abort: () => Promise<void> },
): () => void {
  if (!signal || signal.aborted) return () => {};
  const onAbort = () => {
    void session.abort().catch((err) => {
      console.error("Failed to abort a chat_respond run:", err);
    });
  };
  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}
