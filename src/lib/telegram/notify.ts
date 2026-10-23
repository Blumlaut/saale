import { getTelegramBot } from "./bot";
import { sendTelegramMessage } from "./client";
import { resolveTelegramSendTarget, TelegramTargetError, type TelegramSendTarget } from "./chats";
import { getLinkByUserId, type TelegramLinkInfo } from "./links";
import { recordOutboundMessage } from "./outbound";
import { recordOutboundMessages } from "./outbound-messages";

/**
 * Proactive Telegram delivery.
 *
 * Everything that reaches the user *between* conversations goes through here
 * the `telegram_send` tool, task reminders, and agent job output. Centralising
 * it keeps three behaviours consistent:
 *
 *  - **The recipient is chosen from the caller's own chats.** A delivery goes to
 *    the user's linked private chat unless it names a group that user added the
 *    bot to, so a message the agent decided to send can never land in another
 *    user's chat.
 *  - **Replies keep their context.** Every delivered message is recorded in the
 *    chat that sent it, so replying to it continues that thread instead of
 *    reading as amnesia (`recordOutboundMessage`), and the sent message itself
 *    is written to the outbound ledger so the reply can be routed back
 *    (`recordOutboundMessages`).
 *  - **Failure is data, not a log line.** Callers get a result they must act
 *    on, rather than a message that silently evaporated.
 */

/** Why a delivery could not be attempted or did not land. */
export type TelegramDeliveryFailure =
  /** No bot is configured on this instance (an admin has to set one up). */
  | "bot_not_configured"
  /** A bot exists but an admin switched it off. */
  | "bot_disabled"
  /** This user has not linked their Telegram account yet. */
  | "not_linked"
  /** The named group is not one of this user's, or the bot has left it. */
  | "unknown_target"
  /** Telegram rejected the send (blocked bot, revoked token, rate limit…). */
  | "send_failed";

export interface TelegramDelivery {
  ok: boolean;
  /** The chat the message went to (or would have gone to). */
  chatId?: string;
  /** Display label for that chat. */
  label?: string;
  /** Why delivery failed. Absent when `ok` is true. */
  reason?: TelegramDeliveryFailure;
  /** Human-readable failure detail, safe to show in a tool result. */
  error?: string;
}

/**
 * Send a message to the user's linked chat, record it in the chat that
 * produced it, and ledger the sent messages so a reply finds its way back.
 *
 * Recording failures are logged and swallowed. a message that would otherwise
 * arrive must not be held back because a bookkeeping write failed.
 */
export async function deliverTelegramMessage(params: {
  userId: string;
  encryptedToken: string;
  chatId: bigint;
  content: string;
  /** The chat that produced this message; the home thread when omitted. */
  sourceSessionId?: string | null | undefined;
  /** Group title when the message went to a group, so the source chat sees where. */
  sentTo?: string | null | undefined;
}): Promise<TelegramDelivery> {
  const { userId, encryptedToken, chatId, content, sourceSessionId, sentTo } = params;

  let messageIds: number[];
  try {
    messageIds = await sendTelegramMessage(encryptedToken, chatId, content);
  } catch (err) {
    return {
      ok: false,
      chatId: chatId.toString(),
      reason: "send_failed",
      error: err instanceof Error ? err.message : "Telegram rejected the message",
    };
  }

  // Only a message that arrived has something to reply to, so both records
  // follow the send.
  try {
    await recordOutboundMessage({ userId, content, sourceSessionId, sentTo });
  } catch (err) {
    console.error(`[telegram] Failed to record outbound message for user ${userId}:`, err);
  }

  try {
    await recordOutboundMessages({ userId, chatId, messageIds, sourceSessionId });
  } catch (err) {
    console.error(`[telegram] Failed to ledger outbound messages for user ${userId}:`, err);
  }

  return { ok: true, chatId: chatId.toString() };
}

/**
 * Deliver a message to the user's linked chat, or to one of their groups.
 *
 * This is the entry point for anything that reaches the user without a
 * conversation in progress. It never throws. inspect the result instead.
 *
 * @param params.userId - The Saale user to reach
 * @param params.content - Message text (Markdown; split automatically if long)
 * @param params.sourceSessionId - The chat that produced the message, when one did
 * @param params.target - A group chat id from `telegram_chats`; omit for the private chat
 */
export async function sendTelegramToUser(params: {
  userId: string;
  content: string;
  sourceSessionId?: string | null | undefined;
  target?: string | null | undefined;
}): Promise<TelegramDelivery> {
  const { userId, content, sourceSessionId, target } = params;

  const bot = await getTelegramBot();
  if (!bot) {
    return {
      ok: false,
      reason: "bot_not_configured",
      error:
        "No Telegram bot is configured on this instance. An admin must add one in Admin → Settings → Telegram.",
    };
  }

  if (!bot.enabled) {
    return {
      ok: false,
      reason: "bot_disabled",
      error: "The Telegram bot is switched off. An admin must enable it before messages arrive.",
    };
  }

  // A private delivery needs a link. A group delivery needs the group row, which
  // already belongs to this user, so an unlinked account can still post there.
  let link: TelegramLinkInfo | null = null;
  if (target == null || target.trim() === "") {
    link = await getLinkByUserId(userId);
    if (!link) {
      return {
        ok: false,
        reason: "not_linked",
        error:
          "This user has not linked a Telegram account. Link one in Settings → Integrations → Telegram.",
      };
    }
  }

  // Resolve the destination before sending, so an unknown group is reported
  // with the ones that are available instead of a Telegram error.
  let destination: TelegramSendTarget;
  try {
    destination = await resolveTelegramSendTarget({ userId, target, link });
  } catch (err) {
    if (err instanceof TelegramTargetError) {
      return { ok: false, reason: "unknown_target", error: err.message };
    }
    throw err;
  }

  const delivery = await deliverTelegramMessage({
    userId,
    encryptedToken: bot.encryptedToken,
    chatId: destination.chatId,
    content,
    sourceSessionId,
    sentTo: destination.group ? (destination.label ?? "group") : null,
  });

  return { ...delivery, ...(destination.label ? { label: destination.label } : {}) };
}
