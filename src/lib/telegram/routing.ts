import { prisma } from "@/lib/db";
import { createChatSessionRow } from "@/lib/chat/create-session";
import { getLinkByUserId, type TelegramLinkInfo } from "./links";
import { findOutboundSource } from "./outbound-messages";

/**
 * Which Saale chat a Telegram message continues.
 *
 * A message resolves to the chat that sent the message it answers:
 *
 *  1. the message is a Telegram reply and the ledger knows what it answers;
 *  2. otherwise the chat that last sent a Telegram message;
 *  3. otherwise a new chat, so a message never needs `/new` first.
 *
 * A chat that has since been deleted falls through to the next rule rather than
 * failing the message.
 */

/** How a target was resolved. */
export type TelegramTargetVia = "reply" | "active" | "new";

export interface TelegramTarget {
  sessionId: string;
  via: TelegramTargetVia;
}

/** A chat the user still owns. */
async function chatExists(userId: string, sessionId: string): Promise<boolean> {
  const chat = await prisma.chatSession.findFirst({
    where: { id: sessionId, userId },
    select: { id: true },
  });
  return chat !== null;
}

/** The chat a message continues, or null when it belongs to none. */
export async function resolveTelegramTarget(params: {
  userId: string;
  telegramChatId: bigint;
  /** The message being answered, when the user replied to one. */
  replyToMessageId?: bigint | null | undefined;
  /** The caller's link, when it already has it. */
  link?: TelegramLinkInfo | null;
}): Promise<TelegramTarget | null> {
  const { userId, telegramChatId, replyToMessageId } = params;

  const link = params.link ?? (await getLinkByUserId(userId));
  if (!link) throw new Error("Telegram link not found");

  // Defence in depth: the webhook routed this message in from this link's chat,
  // so a mismatch means the link changed while the message was in flight.
  if (link.telegramChatId !== telegramChatId) {
    throw new Error("Telegram chat does not belong to this user's link");
  }

  if (replyToMessageId != null) {
    const source = await findOutboundSource({
      userId,
      chatId: telegramChatId,
      messageId: replyToMessageId,
    });
    if (source && (await chatExists(userId, source))) {
      return { sessionId: source, via: "reply" };
    }
  }

  const active = link.activeSessionId;
  if (active && (await chatExists(userId, active))) {
    return { sessionId: active, via: "active" };
  }

  return null;
}

/**
 * The chat a message continues, starting one when it belongs to none.
 *
 * A phone user who sends a message expects an answer, so a message with
 * nothing to continue begins a chat instead of asking for `/new`.
 */
export async function resolveOrStartTelegramTarget(params: {
  userId: string;
  telegramChatId: bigint;
  replyToMessageId?: bigint | null | undefined;
  link?: TelegramLinkInfo | null;
}): Promise<TelegramTarget> {
  const target = await resolveTelegramTarget(params);
  if (target) return target;

  return { sessionId: (await createChatSessionRow(params.userId)).id, via: "new" };
}

/**
 * The chat a command sent from Telegram acts on, without creating one.
 *
 * Same rules as a message, except that a command never starts a conversation:
 * with nothing to act on it returns null and the command says so.
 */
export async function resolveExistingTelegramTarget(params: {
  userId: string;
  telegramChatId: bigint;
  replyToMessageId?: bigint | null | undefined;
  link?: TelegramLinkInfo | null;
}): Promise<string | null> {
  const target = await resolveTelegramTarget(params);
  return target ? target.sessionId : null;
}
