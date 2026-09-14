import { prisma } from "@/lib/db";
import { deleteAllImages } from "@/lib/image-attachment";
import { publishSessionEvent } from "@/lib/pi/session-events";
import type { Message } from "@/components/chat/types";
import {
  serializeChatMessage,
  type ChatMessageWithAttachments,
  type QueuedChatMessage,
} from "@/lib/chat/serialize-message";

/**
 * Send queue — messages submitted while a generation is already running.
 *
 * A queued message is a normal ChatMessage row with `queuedAt` set: it is
 * excluded from the conversation (see `listQueuedMessages` callers) until it
 * is delivered, and rendered in the composer's queue strip instead. Delivery
 * is server-side (see the chat stream route's drain), so queued messages are
 * answered even when no client is connected.
 */

/** Send queue cap per session — a runaway client can't queue forever. */
export const MAX_QUEUED_MESSAGES = 20;

/** Claim attempts before giving up on a message another process grabbed. */
const CLAIM_ATTEMPTS = 3;

export async function listQueuedMessages(sessionId: string): Promise<ChatMessageWithAttachments[]> {
  return prisma.chatMessage.findMany({
    where: { sessionId, queuedAt: { not: null } },
    orderBy: { queuedAt: "asc" },
    include: { attachments: true },
  });
}

export function serializeQueuedMessages(messages: ChatMessageWithAttachments[]): Message[] {
  return messages.map(serializeChatMessage);
}

export async function countQueuedMessages(sessionId: string): Promise<number> {
  return prisma.chatMessage.count({ where: { sessionId, queuedAt: { not: null } } });
}

/**
 * Publish the queue's current contents to every connected client.
 *
 * Called after every user-facing queue mutation (enqueue, edit, cancel,
 * deliver). A run that is just starting also publishes a snapshot — see the
 * session event tracker's `agent_start`.
 */
export async function publishQueueUpdate(sessionId: string): Promise<void> {
  try {
    const queued = await listQueuedMessages(sessionId);
    await publishSessionEvent(sessionId, "queue_update", {
      messages: serializeQueuedMessages(queued),
    });
  } catch (err) {
    console.error(`Failed to publish queue update for session ${sessionId}:`, err);
  }
}

/**
 * Take one specific message out of the queue ("send now").
 *
 * Atomic conditional update: returns false when the message was already
 * delivered or cancelled, so callers never act on a stale queue entry twice.
 */
export async function claimQueuedMessage(sessionId: string, messageId: string): Promise<boolean> {
  const claimed = await prisma.chatMessage.updateMany({
    where: { id: messageId, sessionId, queuedAt: { not: null } },
    data: { queuedAt: null },
  });
  return claimed.count === 1;
}

/**
 * Take the oldest queued message out of the queue and return it.
 *
 * The claim is atomic, so two processes draining the same session can never
 * prompt the same message twice: the loser's `updateMany` matches no row and
 * it moves on to the next one.
 */
export async function claimNextQueuedMessage(sessionId: string): Promise<QueuedChatMessage | null> {
  for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt++) {
    const next = await prisma.chatMessage.findFirst({
      where: { sessionId, queuedAt: { not: null } },
      orderBy: { queuedAt: "asc" },
      include: { attachments: true },
    });
    if (!next) return null;

    const queuedAt = next.queuedAt;
    if (!queuedAt) return null; // Filtered out by the query — defensive only.

    if (await claimQueuedMessage(sessionId, next.id)) {
      // queuedAt keeps its original value: the caller can put the message back
      // at the same queue position if the delivery attempt fails.
      return Object.assign({}, next, { queuedAt });
    }
  }

  console.error(`Could not claim a queued message for session ${sessionId} — contention`);
  return null;
}

/**
 * Put a claimed message back at its former queue position.
 *
 * Used when a delivery attempt could not actually prompt (the pooled agent is
 * busy) — the message must not silently disappear from the conversation.
 */
export async function restoreQueuedMessage(
  sessionId: string,
  messageId: string,
  queuedAt: Date,
): Promise<void> {
  const restored = await prisma.chatMessage.updateMany({
    where: { id: messageId, sessionId, queuedAt: null },
    data: { queuedAt },
  });
  if (restored.count === 0) {
    console.error(`Failed to requeue message ${messageId} — it is no longer claimable`);
  }
}

export async function getQueuedMessage(
  sessionId: string,
  messageId: string,
): Promise<ChatMessageWithAttachments | null> {
  return prisma.chatMessage.findFirst({
    where: { id: messageId, sessionId, queuedAt: { not: null } },
    include: { attachments: true },
  });
}

/**
 * Rewrite a queued message's text. Returns null when the message is no longer
 * in the queue (already delivered, cancelled, or never queued).
 */
export async function updateQueuedMessageContent(
  sessionId: string,
  messageId: string,
  content: string,
): Promise<ChatMessageWithAttachments | null> {
  const updated = await prisma.chatMessage.updateMany({
    where: { id: messageId, sessionId, queuedAt: { not: null } },
    data: { content, editedAt: new Date() },
  });
  if (updated.count === 0) return null;
  return getQueuedMessage(sessionId, messageId);
}

/**
 * Drop a queued message and its attachments. Returns false when the message
 * is not queued (a delivered message must not be deleted through this path —
 * the conversation may depend on it).
 */
export async function removeQueuedMessage(
  userId: string,
  sessionId: string,
  messageId: string,
): Promise<boolean> {
  const message = await getQueuedMessage(sessionId, messageId);
  if (!message) return false;

  if (message.attachments.length > 0) {
    try {
      await deleteAllImages(
        userId,
        message.attachments.map((a) => a.storagePath),
      );
    } catch (err) {
      console.error(`Failed to delete files for queued message ${messageId}:`, err);
    }
  }

  const deleted = await prisma.chatMessage.deleteMany({
    where: { id: messageId, sessionId, queuedAt: { not: null } },
  });
  return deleted.count === 1;
}
