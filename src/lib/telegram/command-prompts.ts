import { randomBytes } from "crypto";
import { getRedis } from "@/lib/redis";
import { getCommandMeta } from "@/lib/commands/catalog";
import { executeCommand } from "@/lib/commands/execute";
import type { CommandOption, CommandPrompt } from "@/lib/commands/types";
import { createBot, sendTelegramMessage } from "./client";
import { getEnabledTelegramBot } from "./bot";
import { getLinkByTelegramUserId } from "./links";

/**
 * Telegram adapter for the shared slash-command registry.
 *
 * It carries no command logic: it parses nothing (the webhook already did),
 * executes through `executeCommand`, and renders an interactive command's
 * prompt as an inline keyboard. The registry stays the single source of truth
 * for which commands exist and what they do.
 */

/** Redis key prefix for in-flight interactive command prompts. */
const PROMPT_PREFIX = "saale:command-prompt:";

/** How long a prompt stays usable before the user must send the command again. */
const PROMPT_TTL_S = 10 * 60;

/** Options per keyboard page. 1 button per row, readable on a phone. */
const OPTIONS_PER_PAGE = 6;

/** Telegram caps `answerCallbackQuery` text at 200 characters. */
const CALLBACK_TEXT_MAX = 200;

const TONE_ICONS = { success: "✅", info: "ℹ️", error: "⚠️" } as const;

/** The chat + message a prompt's buttons live on (for editing in place). */
export interface CallbackMessage {
  chat: { id: number };
  message_id: number;
}

/** Prompt state stored in Redis while its keyboard is on screen. */
interface PromptSession {
  token: string;
  userId: string;
  command: string;
  /** bigint as string. JSON cannot carry a bigint. */
  telegramChatId: string;
  replyToMessageId?: number | undefined;
  title: string;
  description?: string | undefined;
  options: CommandOption[];
  page: number;
}

const promptKey = (token: string) => `${PROMPT_PREFIX}${token}`;

/** Escape text for Telegram's HTML parse mode. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Run a command that arrived as a Telegram message and reply.
 *
 * Fire-and-forget from the webhook: the outcome (a reply, or a keyboard) is
 * sent here, and failures are logged rather than surfaced to Telegram.
 */
export async function handleTelegramCommand(params: {
  userId: string;
  encryptedToken: string;
  telegramChatId: bigint;
  name: string;
  args: string;
  replyToMessageId?: number | undefined;
}): Promise<void> {
  const { userId, encryptedToken, telegramChatId, name, args, replyToMessageId } = params;

  const reply = replyToMessageId != null ? { replyToMessageId } : undefined;
  const result = await executeCommand(name, {
    surface: "telegram",
    userId,
    args,
    telegramChatId,
    encryptedToken,
    replyToMessageId,
  });

  if (result.kind === "error") {
    await sendTelegramMessage(encryptedToken, telegramChatId, `⚠️ ${result.error}`, reply);
    return;
  }

  if (result.kind === "done") {
    await sendTelegramMessage(
      encryptedToken,
      telegramChatId,
      `${TONE_ICONS[result.outcome.tone ?? "success"]} ${result.outcome.message}`,
      reply,
    );
    return;
  }

  await sendCommandPrompt({
    userId,
    encryptedToken,
    telegramChatId,
    command: result.name,
    prompt: result.prompt,
    replyToMessageId,
  });
}

/**
 * Render an interactive command's prompt as an inline keyboard.
 *
 * The options are stashed in Redis behind a short token so `callback_data`
 * stays inside Telegram's 64-byte limit; the buttons carry only the token and
 * the absolute option index.
 */
export async function sendCommandPrompt(params: {
  userId: string;
  encryptedToken: string;
  telegramChatId: bigint;
  command: string;
  prompt: CommandPrompt;
  replyToMessageId?: number | undefined;
}): Promise<void> {
  const { userId, encryptedToken, telegramChatId, command, prompt } = params;

  const bot = createBot(encryptedToken);

  if (prompt.options.length === 0) {
    const meta = getCommandMeta(command);
    await bot.api.sendMessage(
      Number(telegramChatId),
      `⚠️ <b>/${escapeHtml(meta?.name ?? command)}</b> has nothing to offer right now.`,
      { parse_mode: "HTML" },
    );
    return;
  }

  const token = randomBytes(8).toString("hex"); // 16 hex chars
  const session: PromptSession = {
    token,
    userId,
    command,
    telegramChatId: telegramChatId.toString(),
    replyToMessageId: params.replyToMessageId,
    title: prompt.title,
    description: prompt.description,
    options: prompt.options,
    page: 0,
  };

  getRedis()
    .setex(promptKey(token), PROMPT_TTL_S, JSON.stringify(session))
    .catch((err) => {
      console.error("Failed to store command prompt session:", err);
    });

  await bot.api.sendMessage(Number(telegramChatId), promptText(session), {
    parse_mode: "HTML",
    reply_markup: buildKeyboard(session) as never,
  });
}

/** Heading shown above the option buttons. */
function promptText(session: PromptSession): string {
  const totalPages = Math.max(Math.ceil(session.options.length / OPTIONS_PER_PAGE), 1);
  const page = Math.min(Math.max(session.page, 0), totalPages - 1);
  const lines = [`⌘ <b>${escapeHtml(session.title)}</b>`];
  if (session.description) lines.push("", escapeHtml(session.description));
  lines.push(
    "",
    `<i>${totalPages > 1 ? `Page ${page + 1}/${totalPages}. t` : "T"}ap an option to apply it.</i>`,
  );
  return lines.join("\n");
}

/** One button per row; pagination controls when the options don't fit. */
function buildKeyboard(session: PromptSession): { inline_keyboard: unknown[] } {
  const totalPages = Math.max(Math.ceil(session.options.length / OPTIONS_PER_PAGE), 1);
  const page = Math.min(Math.max(session.page, 0), totalPages - 1);
  const start = page * OPTIONS_PER_PAGE;

  const rows: Array<Array<{ text: string; callback_data: string }>> = session.options
    .slice(start, start + OPTIONS_PER_PAGE)
    .map((option, index) => [
      {
        text: `${option.current ? "✓ " : ""}${option.label}`,
        callback_data: `c:${session.token}:s:${start + index}`,
      },
    ]);

  if (totalPages > 1) {
    const nav: Array<{ text: string; callback_data: string }> = [];
    if (page > 0) {
      nav.push({ text: "◀️", callback_data: `c:${session.token}:p:${page - 1}` });
    }
    nav.push({ text: `${page + 1}/${totalPages}`, callback_data: `c:${session.token}:n` });
    if (page < totalPages - 1) {
      nav.push({ text: "▶️", callback_data: `c:${session.token}:p:${page + 1}` });
    }
    rows.push(nav);
  }

  return { inline_keyboard: rows };
}

/**
 * Handle a command-prompt button press.
 *
 * User isolation: the press must come from the Telegram account linked to the
 * user the prompt was opened for, and the prompt must target the chat it is
 * reported on. One bot serves every user, so a prompt token leaked or forwarded
 * from another account cannot apply its choice here.
 *
 * @returns `handled: false` when the callback belongs to another subsystem.
 */
export async function handleCommandPromptCallback(
  callbackData: string,
  telegramUserId: bigint,
  message?: CallbackMessage,
): Promise<{ handled: boolean; message?: string }> {
  if (!callbackData.startsWith("c:")) {
    return { handled: false };
  }

  const [, token, action, value] = callbackData.split(":");
  if (!token || token.length !== 16) {
    return { handled: false };
  }

  const redis = getRedis();
  const raw = await redis.get(promptKey(token));
  if (!raw) {
    return { handled: true, message: "⚠️ This prompt expired. Send the command again." };
  }

  let session: PromptSession;
  try {
    session = JSON.parse(raw) as PromptSession;
  } catch (err) {
    console.error("Failed to parse command prompt session:", err);
    return { handled: true, message: "⚠️ This prompt is no longer usable." };
  }

  const [botConfig, link] = await Promise.all([
    getEnabledTelegramBot(),
    getLinkByTelegramUserId(telegramUserId),
  ]);

  if (!botConfig || !link || link.userId !== session.userId) {
    return { handled: true, message: "⚠️ This prompt belongs to a different account." };
  }

  const bot = createBot(botConfig.encryptedToken);
  const edit = async (text: string, keyboard: { inline_keyboard: unknown[] }) => {
    if (!message) return;
    await bot.api.editMessageText(message.chat.id, message.message_id, text, {
      parse_mode: "HTML",
      reply_markup: keyboard as never,
    });
  };

  // Page navigation: re-render the keyboard in place.
  if (action === "p" && value !== undefined) {
    const totalPages = Math.max(Math.ceil(session.options.length / OPTIONS_PER_PAGE), 1);
    session.page = Math.min(Math.max(Number(value) || 0, 0), totalPages - 1);
    await redis.setex(promptKey(token), PROMPT_TTL_S, JSON.stringify(session));
    await edit(promptText(session), buildKeyboard(session));
    return { handled: true };
  }

  // Page indicator button. acknowledge without changing anything.
  if (action === "n") {
    return { handled: true };
  }

  if (action !== "s" || value === undefined) {
    return { handled: false };
  }

  const option = session.options[Number(value)];
  if (!option) {
    return { handled: true, message: "⚠️ That option is no longer available." };
  }

  const result = await executeCommand(
    session.command,
    {
      surface: "telegram",
      userId: session.userId,
      args: "",
      telegramChatId: BigInt(session.telegramChatId),
      encryptedToken: botConfig.encryptedToken,
      replyToMessageId: session.replyToMessageId,
    },
    option.value,
  );

  await redis.del(promptKey(token));

  if (result.kind !== "done") {
    const error = result.kind === "error" ? result.error : "That option is no longer available.";
    await edit(`⚠️ ${escapeHtml(error)}`, { inline_keyboard: [] });
    return { handled: true, message: error.slice(0, CALLBACK_TEXT_MAX) };
  }

  const text = `${TONE_ICONS[result.outcome.tone ?? "success"]} ${escapeHtml(result.outcome.message)}`;
  await edit(text, { inline_keyboard: [] });
  return { handled: true, message: result.outcome.message.slice(0, CALLBACK_TEXT_MAX) };
}
