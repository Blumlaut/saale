import { prisma } from "@/lib/db";
import { sendTelegramMessage } from "./client";
import { resolveNotifyChat } from "./chats";
import { recordTelegramJobOutput } from "./outbound";

/**
 * Proactive Telegram delivery.
 *
 * Everything that reaches the user *between* conversations goes through here —
 * the `telegram_send` tool, task reminders, and agent job output. Centralising
 * it keeps three behaviours consistent:
 *
 *  - **The recipient is never chosen by the model.** Only the user's own
 *    resolved chat is targeted (see `resolveNotifyChat`), so a message the
 *    agent decided to send can never land in a group or another user's chat.
 *  - **Replies keep their context.** Every delivered message is recorded in the
 *    chat's session, so replying to it continues the thread instead of reading
 *    as amnesia (`recordTelegramJobOutput`).
 *  - **Failure is data, not a log line.** Callers get a result they must act
 *    on, rather than a message that silently evaporated.
 */

/** Why a delivery could not be attempted or did not land. */
export type TelegramDeliveryFailure =
  /** No Telegram bot is connected for this user. */
  | "not_configured"
  /** The integration is connected but switched off. */
  | "disabled"
  /** Connected, but no chat is reachable (nothing pinned, no private chat, nobody whitelisted). */
  | "no_chat"
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
 * Send a message to an already-resolved chat and record it in the chat's
 * session so a reply has context.
 *
 * Recording failures are logged and swallowed — a message that would otherwise
 * arrive must not be held back because the session write failed.
 */
export async function deliverTelegramMessage(params: {
  userId: string;
  encryptedToken: string;
  chatId: bigint;
  content: string;
}): Promise<TelegramDelivery> {
  const { userId, encryptedToken, chatId, content } = params;

  try {
    await recordTelegramJobOutput({ userId, telegramChatId: chatId, content });
  } catch (err) {
    console.error(`[telegram] Failed to record outbound message in chat ${chatId}:`, err);
  }

  try {
    await sendTelegramMessage(encryptedToken, chatId, content);
  } catch (err) {
    return {
      ok: false,
      chatId: chatId.toString(),
      reason: "send_failed",
      error: err instanceof Error ? err.message : "Telegram rejected the message",
    };
  }

  return { ok: true, chatId: chatId.toString() };
}

/**
 * Resolve the user's notify chat and deliver a message to it.
 *
 * This is the entry point for anything that reaches the user without a
 * conversation in progress. It never throws — inspect the result instead.
 *
 * @param params.userId - The owner of the Telegram integration
 * @param params.content - Message text (Markdown; split automatically if long)
 */
export async function sendTelegramToUser(params: {
  userId: string;
  content: string;
}): Promise<TelegramDelivery> {
  const { userId, content } = params;

  const account = await prisma.telegramAccount.findUnique({
    where: { userId },
    select: { id: true, encryptedToken: true, enabled: true, notifyChatId: true },
  });

  if (!account) {
    return {
      ok: false,
      reason: "not_configured",
      error:
        "No Telegram bot is connected. The user must add one in Settings → Integrations → Telegram.",
    };
  }

  if (!account.enabled) {
    return {
      ok: false,
      reason: "disabled",
      error:
        "The Telegram integration is disabled. The user must enable it before messages arrive.",
    };
  }

  const target = await resolveNotifyChat(account.id, account.notifyChatId);
  if (!target) {
    return {
      ok: false,
      reason: "no_chat",
      error:
        "No Telegram chat is available to send to. The user must message the bot, or pin a notification chat in Settings → Integrations → Telegram.",
    };
  }

  const delivery = await deliverTelegramMessage({
    userId,
    encryptedToken: account.encryptedToken,
    chatId: target.chatId,
    content,
  });

  return { ...delivery, label: target.label };
}
