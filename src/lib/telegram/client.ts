import { Bot, InputFile, type Context } from "grammy";
import { convert as convertToTelegramMarkdown } from "telegram-markdown-v2";
import { decrypt } from "@/lib/crypto";
import { listCommands } from "@/lib/commands/catalog";
import { TELEGRAM_MAX_MESSAGE_LENGTH, splitMarkdownV2, splitPlainText } from "./message-split";

/** Webhook endpoint. a single path, since there is a single bot. */
const WEBHOOK_PATH = "/api/integrations/telegram/webhook";

/** Telegram's caption ceiling; a longer one is rejected along with the file. */
const TELEGRAM_MAX_CAPTION_LENGTH = 1024;

/** Types Telegram renders inline as a photo rather than a file attachment. */
const PHOTO_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/bmp",
  "image/avif",
]);

function isPhotoMimeType(mimeType: string): boolean {
  return PHOTO_MIME_TYPES.has(mimeType.split(";")[0]?.trim().toLowerCase() ?? "");
}

/** A file to upload to a chat. */
export interface TelegramFileUpload {
  fileName: string;
  mimeType: string;
  buffer: Uint8Array<ArrayBuffer>;
}

/**
 * Get the public base URL for webhook registration.
 * Uses NGROK_URL, VERCEL_URL, or falls back to localhost.
 */
export function getPublicBaseUrl(): string {
  if (process.env.NGROK_URL) return process.env.NGROK_URL;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  if (process.env.NEXT_PUBLIC_BASE_URL) return process.env.NEXT_PUBLIC_BASE_URL;
  // Docker / production: use the app URL from environment
  if (process.env.APP_URL) return process.env.APP_URL;
  return "http://localhost:3630";
}

/**
 * Build the webhook URL Telegram should deliver updates to.
 *
 * The URL is constant. it identifies the instance, not a user. so the
 * `webhookSecret` header is what actually authenticates a delivery.
 */
export function buildWebhookUrl(): string {
  return `${getPublicBaseUrl()}${WEBHOOK_PATH}`;
}

/**
 * Create a grammY Bot instance for the shared bot.
 * Decrypts the stored token and configures the API client.
 */
export function createBot(encryptedToken: string): Bot<Context> {
  const token = decrypt(encryptedToken);
  return new Bot(token);
}

/**
 * Validate a bot token by calling getMe().
 * Accepts a plaintext token (called before encryption in the save flow).
 * Returns bot info if valid, throws if invalid.
 */
export async function validateBotToken(botToken: string) {
  const bot = new Bot(botToken);
  const me = await bot.api.getMe();

  if (!me.is_bot) {
    throw new Error("Invalid bot token. this is not a bot account");
  }

  return {
    botId: me.id,
    botUsername: me.username ?? null,
    botFirstName: me.first_name,
  };
}

/**
 * Publish the slash commands to Telegram's own `/` menu.
 *
 * The list comes from the shared registry, so the bot menu can never drift
 * from the commands the web chat offers.
 */
export async function registerBotCommands(encryptedToken: string): Promise<boolean> {
  const bot = createBot(encryptedToken);
  return bot.api.setMyCommands(
    listCommands("telegram").map((meta) => ({
      command: meta.name,
      description: meta.description,
    })),
  );
}

/**
 * Register the webhook and the command menu with Telegram.
 * Called when an admin saves or re-enables the bot.
 */
export async function registerWebhook(
  encryptedToken: string,
  webhookSecret: string,
): Promise<boolean> {
  const bot = createBot(encryptedToken);
  const url = buildWebhookUrl();

  const result = await bot.api.setWebhook(url, {
    secret_token: webhookSecret,
    drop_pending_updates: false,
  });

  // A bot menu is a nicety. never let it fail the webhook registration.
  await registerBotCommands(encryptedToken).catch((err) => {
    console.error("Failed to register the shared Telegram command menu:", err);
  });

  return result;
}

/**
 * Delete the webhook from Telegram.
 * Called when the bot is disabled or removed.
 */
export async function deleteWebhook(encryptedToken: string): Promise<boolean> {
  const bot = createBot(encryptedToken);
  return bot.api.deleteWebhook({ drop_pending_updates: false });
}

/**
 * Where a sender who has not linked an account is told to go.
 *
 * There is no bot owner to whitelist them any more. the bot belongs to the
 * instance. so the instruction has to be self-service.
 */
export function buildLinkRequiredMessage(): string {
  return (
    `This bot isn't connected to a Saale account yet.\n\n` +
    `Sign in to Saale and open <b>Settings → Integrations → Telegram</b> to link your account, then message me again.\n\n` +
    `${getPublicBaseUrl()}`
  );
}

/** Confirmation that a link code was redeemed. Sent with parse_mode "HTML". */
export function buildLinkSuccessMessage(): string {
  return `✅ <b>Linked.</b>\n\nYour Telegram account is now connected to Saale. just send a message to talk to your agent.`;
}

/** Why a link code was refused, for the sender. Sent with parse_mode "HTML". */
export function buildLinkFailureMessage(reason: "expired" | "already_linked"): string {
  if (reason === "already_linked") {
    return (
      `⚠️ This Telegram account is already linked to a different Saale account.\n\n` +
      `Unlink it there first (Settings → Integrations → Telegram), then link it again.`
    );
  }

  return (
    `⚠️ That link is invalid or has expired.\n\n` +
    `Open Saale → Settings → Integrations → Telegram and use the link button again.`
  );
}

/**
 * Send a message to a Telegram chat.
 * Handles splitting long messages into chunks (Telegram limit: 4096 chars).
 *
 * Returns the message IDs of all chunks sent (a single message may become
 * several Telegram messages).
 */
export async function sendTelegramMessage(
  encryptedToken: string,
  chatId: bigint,
  text: string,
  options?: {
    replyToMessageId?: number;
    parseMode?: "HTML" | "Markdown" | "MarkdownV2";
  },
): Promise<number[]> {
  const bot = createBot(encryptedToken);
  const parseMode: "HTML" | "Markdown" | "MarkdownV2" = options?.parseMode ?? "MarkdownV2";

  // Convert Markdown to Telegram's MarkdownV2 using a proper parser. the
  // whole text first, then split the converted output. telegram-markdown-v2
  // uses remark to build an AST, so unmatched formatting chars (like a stray
  // "*" in "*arr apps") are safely escaped instead of breaking the parse.
  // Escaping adds backslash characters that count toward Telegram's 4096
  // limit, so splitting the raw markdown and converting per chunk can still
  // overflow (and get rejected with "message is too long").
  const converted = parseMode === "MarkdownV2" ? convertToTelegramMarkdown(text, "escape") : text;
  const chunks =
    parseMode === "MarkdownV2"
      ? splitMarkdownV2(converted, TELEGRAM_MAX_MESSAGE_LENGTH)
      : splitPlainText(converted, TELEGRAM_MAX_MESSAGE_LENGTH);

  const messageIds: number[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (!chunk) continue;

    const replyParams =
      i === 0 && options?.replyToMessageId != null
        ? { message_id: options.replyToMessageId }
        : undefined;

    const sendMessageParams: Record<string, unknown> = { parse_mode: parseMode };
    if (replyParams) {
      sendMessageParams.reply_parameters = replyParams;
    }

    const result = await bot.api.sendMessage(
      Number(chatId),
      chunk,
      sendMessageParams as Record<string, never>,
    );
    messageIds.push(result.message_id);
  }

  return messageIds;
}

/**
 * Send a single file to a Telegram chat.
 *
 * Returns the message ID Telegram assigned it.
 */
export async function sendTelegramFile(
  encryptedToken: string,
  chatId: bigint,
  file: TelegramFileUpload,
  options?: { caption?: string },
): Promise<number> {
  const bot = createBot(encryptedToken);
  const chat = Number(chatId);

  // The caption is decoration on the file itself. a parse error in it would
  // cost the user the file, so it travels as plain text.
  const caption = options?.caption?.trim().slice(0, TELEGRAM_MAX_CAPTION_LENGTH);
  const params = caption ? { caption } : {};

  if (isPhotoMimeType(file.mimeType)) {
    try {
      const result = await bot.api.sendPhoto(
        chat,
        new InputFile(file.buffer, file.fileName),
        params,
      );
      return result.message_id;
    } catch (err) {
      // Telegram only renders a photo it can lay out (dimension and aspect
      // ratio ceilings). the same bytes still arrive as a document.
      console.warn(`Telegram refused "${file.fileName}" as a photo, sending a document:`, err);
    }
  }

  const result = await bot.api.sendDocument(
    chat,
    new InputFile(file.buffer, file.fileName),
    params,
  );
  return result.message_id;
}

/** A group as Telegram describes it. */
export interface TelegramChatInfo {
  chatId: bigint;
  title: string | null;
  /** "group" | "supergroup" | "channel" */
  kind: string;
  /** Null when Telegram would not answer for this chat. */
  memberCount: number | null;
}

/**
 * Read a group's title, kind and size.
 *
 * Bots cannot list members. `getChatMemberCount` gives a number, and a bot that
 * is not an admin may be refused it, so a missing count is not an error.
 */
export async function getTelegramChatInfo(
  encryptedToken: string,
  chatId: bigint,
): Promise<TelegramChatInfo> {
  const bot = createBot(encryptedToken);
  const chat = await bot.api.getChat(Number(chatId));

  const memberCount = await bot.api.getChatMemberCount(Number(chatId)).catch((err: unknown) => {
    console.warn(`Telegram refused the member count for chat ${chatId}:`, err);
    return null;
  });

  return {
    chatId,
    title: "title" in chat ? (chat.title ?? null) : null,
    kind: chat.type,
    memberCount,
  };
}

/** Leave a group, so a refused add does not leave the bot sitting in it. */
export async function leaveTelegramChat(encryptedToken: string, chatId: bigint): Promise<void> {
  const bot = createBot(encryptedToken);
  await bot.api.leaveChat(Number(chatId));
}

/** Escape text for a Telegram HTML message. A group title is not ours to trust. */
export function escapeTelegramHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Why the bot will not stay in a group.
 *
 * It names the Settings page and nothing else, so it says nothing about who
 * owns the group to the members reading it.
 */
export function buildGroupRefusedMessage(): string {
  return (
    `This bot only joins a group when the person adding it has a Saale account linked in ` +
    `<b>Settings → Integrations → Telegram</b>. Leaving.`
  );
}

/** Confirmation, in the adder's private chat, that a group was registered. */
export function buildGroupAddedMessage(title: string | null): string {
  const name = title ? `"${escapeTelegramHtml(title)}"` : "the group";
  return `✅ <b>Added to ${name}.</b>\n\nAsk me to send a message there and it goes to the group.`;
}

/**
 * Send a single typing indicator to a Telegram chat.
 * Telegram only shows the indicator for ~5 seconds, so this must be
 * called repeatedly to keep it visible during long operations.
 */
export async function sendTypingIndicator(encryptedToken: string, chatId: bigint): Promise<void> {
  const bot = createBot(encryptedToken);
  // Fire-and-forget. errors are logged but don't break the flow
  bot.api.sendChatAction(Number(chatId), "typing").catch((err) => {
    console.error("Failed to send typing indicator:", err);
  });
}

/**
 * Interval (ms) between typing indicator refreshes.
 * Telegram shows the indicator for ~5 seconds; 4s keeps it visible with headroom.
 */
const TYPING_REFRESH_INTERVAL_MS = 4_000;

/**
 * Start a recurring typing indicator that refreshes until stopped.
 * Returns a cleanup function to stop the interval.
 */
export function startTypingIndicator(encryptedToken: string, chatId: bigint): () => void {
  const interval = setInterval(() => {
    sendTypingIndicator(encryptedToken, chatId);
  }, TYPING_REFRESH_INTERVAL_MS);

  // Send the first one immediately
  sendTypingIndicator(encryptedToken, chatId);

  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(interval);
  };
}
