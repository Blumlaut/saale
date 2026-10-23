import { prisma } from "@/lib/db";
import { TELEGRAM_BOT_ID } from "./bot";

/**
 * The outbound ledger: every message Saale sent into Telegram, and the chat it
 * came from.
 *
 * A Telegram reply carries the id of the message it answers, so the ledger turns
 * "which conversation is this about" into one lookup. Telegram keeps
 * `message_id` unique within a chat, which is the natural key. A long message is
 * split into several Telegram messages, so one delivery writes several rows, all
 * naming the same source chat.
 *
 * Rows are kept for `OUTBOUND_TTL_DAYS` and pruned on the next delivery for the
 * same user. a reply arrives within days, so the table stays small without a
 * scheduler of its own.
 */

/** How long a sent message stays resolvable as a reply target. */
export const OUTBOUND_TTL_DAYS = (() => {
  const raw = Number(process.env.TELEGRAM_OUTBOUND_TTL_DAYS);
  return Number.isFinite(raw) && raw > 0 ? raw : 90;
})();

/**
 * Record the messages one delivery produced.
 *
 * Best-effort: a delivery that arrived must not be reported as failed because
 * the ledger write did, so callers log and carry on.
 */
export async function recordOutboundMessages(params: {
  userId: string;
  chatId: bigint;
  messageIds: readonly number[];
  /** The chat that produced the message. Absent when nothing in Saale did. */
  sourceSessionId?: string | null | undefined;
}): Promise<void> {
  const { userId, chatId, messageIds, sourceSessionId } = params;
  if (messageIds.length === 0) return;

  const cutoff = new Date(Date.now() - OUTBOUND_TTL_DAYS * 24 * 60 * 60 * 1000);

  await prisma.$transaction([
    prisma.telegramOutboundMessage.createMany({
      data: messageIds.map((messageId) => ({
        userId,
        botId: TELEGRAM_BOT_ID,
        chatId,
        messageId: BigInt(messageId),
        sessionId: sourceSessionId ?? null,
      })),
      skipDuplicates: true,
    }),
    prisma.telegramOutboundMessage.deleteMany({
      where: { userId, createdAt: { lt: cutoff } },
    }),
    ...(sourceSessionId
      ? [
          prisma.telegramLink.updateMany({
            where: { userId },
            data: { lastOutboundSessionId: sourceSessionId },
          }),
        ]
      : []),
  ]);
}

/**
 * The chat a replied-to message came from.
 *
 * Scoped to the user whose link received the reply, so a message id from
 * another account's chat can never resolve. Null means the message predates the
 * ledger, was a reminder, or has aged out. the caller falls back.
 */
export async function findOutboundSource(params: {
  userId: string;
  chatId: bigint;
  messageId: bigint;
}): Promise<string | null> {
  const { userId, chatId, messageId } = params;

  const row = await prisma.telegramOutboundMessage.findUnique({
    where: { chatId_messageId: { chatId, messageId } },
    select: { userId: true, sessionId: true },
  });

  if (!row || row.userId !== userId) return null;
  return row.sessionId;
}
