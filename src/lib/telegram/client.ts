import { Bot, type Context } from "grammy";
import { convert as convertToTelegramMarkdown } from "telegram-markdown-v2";
import { decrypt } from "@/lib/crypto";
import { prisma } from "@/lib/db";
import { TELEGRAM_MAX_MESSAGE_LENGTH, splitMarkdownV2, splitPlainText } from "./message-split";

/** Webhook endpoint pattern */
const WEBHOOK_PATH = "/api/integrations/telegram/webhook";

/**
 * Get the public base URL for webhook registration.
 * Uses NGROK_URL, VERCEL_URL, or falls back to localhost.
 */
function getPublicBaseUrl(): string {
  if (process.env.NGROK_URL) return process.env.NGROK_URL;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  if (process.env.NEXT_PUBLIC_BASE_URL) return process.env.NEXT_PUBLIC_BASE_URL;
  // Docker / production: use the app URL from environment
  if (process.env.APP_URL) return process.env.APP_URL;
  return "http://localhost:3630";
}

/**
 * Build the full webhook URL for a specific Telegram account.
 */
export function buildWebhookUrl(accountId: string): string {
  return `${getPublicBaseUrl()}${WEBHOOK_PATH}/${accountId}`;
}

/**
 * Create a grammY Bot instance for a given account.
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
    throw new Error("Invalid bot token — this is not a bot account");
  }

  return {
    botId: me.id,
    botUsername: me.username ?? null,
    botFirstName: me.first_name,
  };
}

/**
 * Register the webhook with Telegram.
 * Called when a user enables or updates their Telegram integration.
 */
export async function registerWebhook(
  encryptedToken: string,
  accountId: string,
  webhookSecret: string,
): Promise<boolean> {
  const bot = createBot(encryptedToken);
  const url = buildWebhookUrl(accountId);

  const result = await bot.api.setWebhook(url, {
    secret_token: webhookSecret,
    drop_pending_updates: false,
  });

  return result;
}

/**
 * Delete the webhook from Telegram.
 * Called when a user disables or removes their Telegram integration.
 */
export async function deleteWebhook(encryptedToken: string): Promise<boolean> {
  const bot = createBot(encryptedToken);
  return bot.api.deleteWebhook({ drop_pending_updates: false });
}

/**
 * Re-register webhooks for all enabled Telegram accounts.
 * Called on server startup to ensure webhooks are active after restarts.
 */
export async function registerAllWebhooks(): Promise<void> {
  const accounts = await prisma.telegramAccount.findMany({
    where: { enabled: true },
    select: {
      id: true,
      encryptedToken: true,
      webhookSecret: true,
    },
  });

  for (const account of accounts) {
    try {
      await registerWebhook(account.encryptedToken, account.id, account.webhookSecret);
    } catch (err) {
      console.error(`Failed to register webhook for account ${account.id}:`, err);
    }
  }

  if (accounts.length > 0) {
    // Logged by caller (worker startup)
  }
}

/**
 * Look up a TelegramAccount by its webhook secret.
 * Used by the webhook handler to route incoming updates to the correct account.
 */
export async function findAccountByWebhookSecret(webhookSecret: string): Promise<{
  id: string;
  userId: string;
  encryptedToken: string;
  enabled: boolean;
  webhookSecret: string;
} | null> {
  const account = await prisma.telegramAccount.findFirst({
    where: { webhookSecret },
    select: {
      id: true,
      userId: true,
      encryptedToken: true,
      enabled: true,
      webhookSecret: true,
    },
  });

  return account ?? null;
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

  // Convert Markdown to Telegram's MarkdownV2 using a proper parser — the
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
 * Send a single typing indicator to a Telegram chat.
 * Telegram only shows the indicator for ~5 seconds, so this must be
 * called repeatedly to keep it visible during long operations.
 */
export async function sendTypingIndicator(encryptedToken: string, chatId: bigint): Promise<void> {
  const bot = createBot(encryptedToken);
  // Fire-and-forget — errors are logged but don't break the flow
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
