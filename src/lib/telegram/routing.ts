import { prisma } from "@/lib/db";
import { getLinkByUserId, type TelegramLinkInfo } from "./links";
import { findOutboundSource } from "./outbound-messages";

/**
 * Which Saale chat a Telegram message continues.
 *
 * The bot used to keep one chat of its own, so a reply to an alert from a job or
 * another conversation landed somewhere that knew nothing about it. Instead a
 * message resolves to the chat that sent the message it answers:
 *
 *  1. the message is a Telegram reply and the ledger knows what it answers;
 *  2. otherwise the chat that last sent a Telegram message;
 *  3. otherwise the link's home thread, which is the old dedicated chat and
 *     stays as the place a conversation starts.
 *
 * A chat that has since been deleted falls through to the next rule rather than
 * failing the message.
 */

/** How a target was resolved. `home` is the dedicated Telegram thread. */
export type TelegramTargetVia = "reply" | "last_sent" | "home";

export interface TelegramTarget {
  sessionId: string;
  via: TelegramTargetVia;
}

/** Telegram chats expire after this many ms of inactivity (6 hours) */
const TELEGRAM_CHAT_EXPIRY_MS = 6 * 60 * 60 * 1000;

/** Whether the session has sat unused past the chat's expiry window. */
async function isSessionExpired(sessionId: string): Promise<boolean> {
  const [lastMessage] = await prisma.chatMessage.findMany({
    where: { sessionId },
    orderBy: { createdAt: "desc" },
    take: 1,
  });

  // No messages at all means the session was created but never used. expired.
  return (
    lastMessage == null || lastMessage.createdAt.getTime() + TELEGRAM_CHAT_EXPIRY_MS < Date.now()
  );
}

/** A chat the user still owns. */
async function chatExists(userId: string, sessionId: string): Promise<boolean> {
  const chat = await prisma.chatSession.findFirst({
    where: { id: sessionId, userId },
    select: { id: true },
  });
  return chat !== null;
}

/** The chat a message should continue, or the home thread when nothing else fits. */
export async function resolveTelegramTarget(params: {
  userId: string;
  telegramChatId: bigint;
  /** The message being answered, when the user replied to one. */
  replyToMessageId?: bigint | null | undefined;
  /** The caller's link, when it already has it. */
  link?: TelegramLinkInfo | null;
}): Promise<TelegramTarget> {
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

  const lastSent = link.lastOutboundSessionId;
  if (lastSent && (await chatExists(userId, lastSent))) {
    return { sessionId: lastSent, via: "last_sent" };
  }

  return { sessionId: await ensureHomeThread(userId, link), via: "home" };
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
  const { userId, telegramChatId, replyToMessageId } = params;

  const link = params.link ?? (await getLinkByUserId(userId));
  if (!link) throw new Error("Telegram link not found");
  if (link.telegramChatId !== telegramChatId) {
    throw new Error("Telegram chat does not belong to this user's link");
  }

  if (replyToMessageId != null) {
    const source = await findOutboundSource({
      userId,
      chatId: telegramChatId,
      messageId: replyToMessageId,
    });
    if (source && (await chatExists(userId, source))) return source;
  }

  const lastSent = link.lastOutboundSessionId;
  if (lastSent && (await chatExists(userId, lastSent))) return lastSent;

  if (link.sessionId && (await chatExists(userId, link.sessionId))) return link.sessionId;

  return null;
}

/**
 * Find or create the link's home thread.
 *
 * The link remembers it, because a link is exactly one user and one private
 * chat, so there is no per-chat row to look up. It expires after six hours of
 * inactivity so a stale thread starts clean instead of carrying an unbounded
 * history.
 */
export async function ensureHomeThread(
  userId: string,
  link?: TelegramLinkInfo | null,
): Promise<string> {
  const current = link ?? (await getLinkByUserId(userId));
  if (!current) throw new Error("Telegram link not found");

  if (current.sessionId && !(await isSessionExpired(current.sessionId))) {
    return current.sessionId;
  }

  const sessionId = crypto.randomUUID();

  await prisma.$transaction(async (tx) => {
    await tx.chatSession.create({
      data: {
        id: sessionId,
        userId,
        title: "Telegram Chat",
        temporary: false,
      },
    });

    await tx.telegramLink.update({
      where: { userId },
      data: { sessionId },
    });
  });

  return sessionId;
}
