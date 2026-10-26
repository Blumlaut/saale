/**
 * Plugin dialogs on Telegram.
 *
 * A plugin's `ctx.ui` dialog blocks its run, and the user may not be looking at
 * the browser. The dialog goes to their linked Telegram chat instead: an inline
 * keyboard for `select`/`confirm`, a prompt for a reply for `input`/`editor`.
 * Either way the answer lands on the same Redis request the web chat polls, so
 * whichever surface answers first wins and the other one clears.
 *
 * Only the user the dialog was opened for can answer it: one bot serves every
 * account, so a token forwarded from another chat must not decide anything.
 */

import { randomBytes } from "node:crypto";
import { getRedis } from "@/lib/redis";
import {
  getPendingPluginUiRequests,
  resolvePluginUiRequest,
  type PluginUiKind,
  type PluginUiRequest,
  type PluginUiResponse,
} from "@/lib/plugin-ui/requests";
import { createBot } from "./client";
import { getEnabledTelegramBot } from "./bot";
import { getLinkByTelegramUserId, getLinkByUserId } from "./links";

/** In-flight dialog keyboards. Expires with the dialog, not before. */
const DIALOG_KEY_PREFIX = "saale:plugin-ui-tg:";

/** The dialog an `input`/`editor` prompt takes its next text message for. */
const REPLY_KEY_PREFIX = "saale:plugin-ui-tg-reply:";

/** Where a request's keyboard message sits, for clearing it from another surface. */
const MESSAGE_KEY_PREFIX = "saale:plugin-ui-tg-msg:";

/** How long a keyboard or reply prompt stays usable. */
const DIALOG_TTL_S = 15 * 60;

/** Options per keyboard page. 1 button per row, readable on a phone. */
const OPTIONS_PER_PAGE = 6;

/** Buttons: `p:<token>:<action>:<value>`. `p` is not taken by another card. */
const CALLBACK_PREFIX = "p:";

const PLUGIN_ICON = "🔌";

/** State stored in Redis while a dialog's keyboard is on screen. */
interface DialogSession {
  token: string;
  requestId: string;
  sessionId: string;
  /** The Saale user the dialog belongs to. A press has to come from their link. */
  userId: string;
  kind: PluginUiKind;
  title: string;
  message: string | null;
  options: string[];
  page: number;
  telegramChatId: string;
  /** The message the keyboard is attached to. Paging edits it in place. */
  messageId: number;
}

/** What a text reply is going to answer. */
interface ReplySession {
  requestId: string;
  sessionId: string;
  userId: string;
  telegramChatId: string;
  /** The prompt. Only a reply to it is taken as the answer. */
  messageId: number;
}

const dialogKey = (token: string) => `${DIALOG_KEY_PREFIX}${token}`;
const replyKey = (telegramUserId: string) => `${REPLY_KEY_PREFIX}${telegramUserId}`;
const messageKey = (sessionId: string, requestId: string) =>
  `${MESSAGE_KEY_PREFIX}${sessionId}:${requestId}`;

/** Chat and message of a dialog, so a keyboard can be cleared from elsewhere. */
interface MessageRef {
  telegramChatId: string;
  messageId: number;
}

/** Escape text for Telegram's HTML parse mode. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Send a plugin's dialog to the user's Telegram chat.
 *
 * Fire-and-forget from the request: a user without a bot or a link is answered
 * in the browser only, and a Telegram failure must not fail the plugin's run.
 */
export async function notifyTelegramPluginUi(request: PluginUiRequest): Promise<void> {
  const [botConfig, link] = await Promise.all([
    getEnabledTelegramBot(),
    getLinkByUserId(request.userId),
  ]);
  if (!botConfig || !link) return;

  if (request.kind === "select" && (request.options?.length ?? 0) === 0) return;

  const bot = createBot(botConfig.encryptedToken);
  const chatId = Number(link.telegramChatId);

  if (request.kind === "input" || request.kind === "editor") {
    const sent = await bot.api.sendMessage(chatId, promptText(request), { parse_mode: "HTML" });
    const session: ReplySession = {
      requestId: request.id,
      sessionId: request.sessionId,
      userId: request.userId,
      telegramChatId: link.telegramChatId.toString(),
      messageId: sent.message_id,
    };
    await getRedis().setex(
      replyKey(link.telegramUserId.toString()),
      DIALOG_TTL_S,
      JSON.stringify(session),
    );
    return;
  }

  const token = randomBytes(8).toString("hex");
  const session: DialogSession = {
    token,
    requestId: request.id,
    sessionId: request.sessionId,
    userId: request.userId,
    kind: request.kind,
    title: request.title,
    message: request.message ?? null,
    options: request.options ?? [],
    page: 0,
    telegramChatId: link.telegramChatId.toString(),
    messageId: 0,
  };

  const sent = await bot.api.sendMessage(chatId, dialogText(session), {
    parse_mode: "HTML",
    reply_markup: buildKeyboard(session) as never,
  });
  session.messageId = sent.message_id;

  const ref: MessageRef = {
    telegramChatId: session.telegramChatId,
    messageId: session.messageId,
  };
  await Promise.all([
    getRedis().setex(dialogKey(token), DIALOG_TTL_S, JSON.stringify(session)),
    getRedis().setex(messageKey(request.sessionId, request.id), DIALOG_TTL_S, JSON.stringify(ref)),
  ]);
}

/**
 * Drop a dialog's keyboard when another surface answered it.
 *
 * The chat and Telegram both carry the same dialog, and whichever is answered
 * first leaves the other one looking open until it is cleared here.
 */
export async function clearTelegramPluginDialog(
  sessionId: string,
  requestId: string,
): Promise<void> {
  const redis = getRedis();
  const key = messageKey(sessionId, requestId);

  try {
    const raw = await redis.get(key);
    if (!raw) return;
    await redis.del(key);

    const ref = JSON.parse(raw) as MessageRef;
    const botConfig = await getEnabledTelegramBot();
    if (!botConfig) return;

    await createBot(botConfig.encryptedToken).api.editMessageText(
      ref.telegramChatId,
      ref.messageId,
      "✅ Answered in the chat.",
      { reply_markup: { inline_keyboard: [] } as never },
    );
  } catch (err) {
    console.error("Failed to clear a plugin dialog on Telegram:", err);
  }
}

/** The question, plus what a tap will do. */
function dialogText(session: DialogSession): string {
  const lines = [`${PLUGIN_ICON} <b>${escapeHtml(session.title)}</b>`];
  if (session.message) lines.push("", escapeHtml(session.message));
  lines.push(
    "",
    `<i>A plugin is waiting on this answer. ${
      session.kind === "confirm" ? "Confirm or dismiss it." : "Tap an option to answer."
    }</i>`,
  );
  return lines.join("\n");
}

/** Title + body of a dialog answered by typing. */
function promptText(request: PluginUiRequest): string {
  const lines = [`${PLUGIN_ICON} <b>${escapeHtml(request.title)}</b>`];
  if (request.message) lines.push("", escapeHtml(request.message));
  if (request.prefill) lines.push("", `<pre>${escapeHtml(request.prefill)}</pre>`);
  lines.push("", "<i>A plugin is waiting on this answer. Reply to this message with it.</i>");
  return lines.join("\n");
}

/** One button per row; pagination when a select has more choices than fit. */
function buildKeyboard(session: DialogSession): { inline_keyboard: unknown[] } {
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];

  if (session.kind === "confirm") {
    rows.push([
      { text: "✅ Confirm", callback_data: `${CALLBACK_PREFIX}${session.token}:c:1` },
      { text: "❌ Dismiss", callback_data: `${CALLBACK_PREFIX}${session.token}:c:0` },
    ]);
    return { inline_keyboard: rows };
  }

  const totalPages = Math.max(Math.ceil(session.options.length / OPTIONS_PER_PAGE), 1);
  const page = Math.min(Math.max(session.page, 0), totalPages - 1);
  const start = page * OPTIONS_PER_PAGE;

  for (const [index, option] of session.options.slice(start, start + OPTIONS_PER_PAGE).entries()) {
    rows.push([
      {
        text: option,
        callback_data: `${CALLBACK_PREFIX}${session.token}:s:${start + index}`,
      },
    ]);
  }

  if (totalPages > 1) {
    const nav: Array<{ text: string; callback_data: string }> = [];
    if (page > 0)
      nav.push({ text: "◀️", callback_data: `${CALLBACK_PREFIX}${session.token}:g:${page - 1}` });
    nav.push({
      text: `${page + 1}/${totalPages}`,
      callback_data: `${CALLBACK_PREFIX}${session.token}:n`,
    });
    if (page < totalPages - 1) {
      nav.push({ text: "▶️", callback_data: `${CALLBACK_PREFIX}${session.token}:g:${page + 1}` });
    }
    rows.push(nav);
  }

  rows.push([{ text: "✖️ Dismiss", callback_data: `${CALLBACK_PREFIX}${session.token}:x` }]);
  return { inline_keyboard: rows };
}

/**
 * Handle a plugin dialog button press.
 *
 * User isolation: the press has to come from the Telegram account linked to the
 * user the dialog was opened for.
 *
 * @returns `handled: false` when the callback belongs to another subsystem.
 */
export async function handlePluginDialogCallback(
  callbackData: string,
  telegramUserId: bigint,
): Promise<{ handled: boolean; message?: string }> {
  if (!callbackData.startsWith(CALLBACK_PREFIX)) return { handled: false };

  const [, token, action, value] = callbackData.split(":");
  if (!token || token.length !== 16 || !action) return { handled: false };

  const redis = getRedis();
  const raw = await redis.get(dialogKey(token));
  if (!raw) return { handled: true, message: "⚠️ This dialog expired." };

  let session: DialogSession;
  try {
    session = JSON.parse(raw) as DialogSession;
  } catch (err) {
    console.error("Failed to parse a Telegram plugin dialog session:", err);
    return { handled: true, message: "⚠️ This dialog is no longer usable." };
  }

  const [botConfig, link] = await Promise.all([
    getEnabledTelegramBot(),
    getLinkByTelegramUserId(telegramUserId),
  ]);
  if (!botConfig || !link || link.userId !== session.userId) {
    return { handled: true, message: "⚠️ This dialog belongs to a different account." };
  }

  const totalPages = Math.max(Math.ceil(session.options.length / OPTIONS_PER_PAGE), 1);

  // Paging changes the keyboard, not the request.
  if (action === "g" && value !== undefined) {
    session.page = Math.min(Math.max(Number(value) || 0, 0), totalPages - 1);
    await redis.setex(dialogKey(token), DIALOG_TTL_S, JSON.stringify(session));
    await redrawDialog(botConfig, session);
    return { handled: true, message: `Page ${session.page + 1}/${totalPages}` };
  }
  if (action === "n") return { handled: true, message: `Page ${session.page + 1}/${totalPages}` };

  const answer = answerFrom(session, action, value);
  if (!answer) return { handled: true, message: "⚠️ That option is no longer available." };

  const answered = await resolvePluginUiRequest(session.sessionId, session.requestId, answer);
  await redis.del(dialogKey(token));
  await redis.del(messageKey(session.sessionId, session.requestId));
  if (!answered) {
    await settleDialog(botConfig, session, "⚠️ Answered elsewhere.");
    return { handled: true, message: "⚠️ Already answered." };
  }

  const text = describeAnswer(answer, session.options);
  await settleDialog(botConfig, session, text);
  return { handled: true, message: text };
}

/** Re-send the keyboard for the page the user moved to. */
async function redrawDialog(
  botConfig: { encryptedToken: string },
  session: DialogSession,
): Promise<void> {
  try {
    await createBot(botConfig.encryptedToken).api.editMessageText(
      session.telegramChatId,
      session.messageId,
      dialogText(session),
      { parse_mode: "HTML", reply_markup: buildKeyboard(session) as never },
    );
  } catch (err) {
    console.error("Failed to page a plugin dialog on Telegram:", err);
  }
}

/** Replace the keyboard with the outcome, so it stops looking open. */
async function settleDialog(
  botConfig: { encryptedToken: string },
  session: DialogSession,
  text: string,
): Promise<void> {
  try {
    await createBot(botConfig.encryptedToken).api.editMessageText(
      session.telegramChatId,
      session.messageId,
      text,
      { reply_markup: { inline_keyboard: [] } as never },
    );
  } catch (err) {
    console.error("Failed to settle a plugin dialog on Telegram:", err);
  }
}

/** What the plugin receives for a press. */
function answerFrom(
  session: DialogSession,
  action: string,
  value: string | undefined,
): PluginUiResponse | null {
  if (action === "x") return { cancelled: true };
  if (action === "c") return { confirmed: value === "1" };
  if (action === "s" && value !== undefined) {
    const option = session.options[Number(value)];
    return option === undefined ? null : { value: option };
  }
  return null;
}

/** The answer, as the callback toast and as the text the keyboard is replaced with. */
function describeAnswer(answer: PluginUiResponse, options: string[]): string {
  if (answer.cancelled) return "✖️ Dismissed";
  if (answer.confirmed !== undefined) return answer.confirmed ? "✅ Confirmed" : "❌ Dismissed";
  if (answer.value !== undefined)
    return `✅ ${options.includes(answer.value) ? answer.value : "Answered"}`;
  return "✅ Answered";
}

/**
 * Take a text message as the answer to a waiting `input`/`editor` dialog.
 *
 * @returns `consumed: true` once the message has answered a dialog (or tried
 *          to), so the caller does not also run it as a chat prompt.
 */
export async function takePluginDialogReply(params: {
  userId: string;
  telegramUserId: bigint;
  telegramChatId: bigint;
  text: string;
  /** The message this one replies to, when it replies at all. */
  replyToMessageId?: number | undefined;
}): Promise<{ consumed: boolean; note?: string }> {
  const key = replyKey(params.telegramUserId.toString());
  const redis = getRedis();
  const raw = await redis.get(key);
  if (!raw) return { consumed: false };

  let session: ReplySession;
  try {
    session = JSON.parse(raw) as ReplySession;
  } catch (err) {
    await redis.del(key);
    console.error("Failed to parse a Telegram plugin dialog reply session:", err);
    return { consumed: true, note: "⚠️ That dialog is no longer usable." };
  }

  if (
    session.userId !== params.userId ||
    session.telegramChatId !== params.telegramChatId.toString()
  ) {
    return { consumed: false };
  }

  // The prompt says to reply to it, and anything else is a message meant for
  // the agent: taking it would swallow a prompt the user never aimed here.
  if (params.replyToMessageId !== session.messageId) return { consumed: false };

  await redis.del(key);

  // The dialog may have been answered in the browser, or expired, while the
  // user was typing. Their text was meant as the answer, so it is not run.
  const pending = await getPendingPluginUiRequests(session.sessionId);
  if (!pending.some((request) => request.id === session.requestId)) {
    return { consumed: true, note: "⚠️ This dialog was already answered or expired." };
  }

  const answered = await resolvePluginUiRequest(session.sessionId, session.requestId, {
    value: params.text,
  });
  return {
    consumed: true,
    ...(answered ? {} : { note: "⚠️ This dialog was already answered or expired." }),
  };
}
