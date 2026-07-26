import { Bot, type Context } from "grammy";
import { decrypt } from "@/lib/crypto";
import { prisma } from "@/lib/db";

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
 */
export async function sendTelegramMessage(
  encryptedToken: string,
  chatId: bigint,
  text: string,
  options?: {
    replyToMessageId: number | undefined;
    parseMode?: "HTML" | "Markdown" | "MarkdownV2";
  },
): Promise<number[]> {
  const bot = createBot(encryptedToken);
  const messageIds: number[] = [];

  // Telegram has a 4096 character limit per message
  const chunks = splitMessage(text, 4096);

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (!chunk) continue;

    const replyParams =
      i === 0 && options?.replyToMessageId != null
        ? { message_id: options.replyToMessageId }
        : undefined;

    const parseMode: "HTML" | "Markdown" | "MarkdownV2" = options?.parseMode ?? "MarkdownV2";
    const sendMessageParams: Record<string, unknown> = { parse_mode: parseMode };
    if (replyParams) {
      sendMessageParams.reply_parameters = replyParams;
    }

    // Escape special characters for MarkdownV2 (AI-generated messages are Markdown,
    // so we preserve formatting syntax but escape chars that would break parsing)
    const processedChunk = parseMode === "MarkdownV2" ? escapeMarkdownV2(chunk) : chunk;

    const result = await bot.api.sendMessage(
      Number(chatId),
      processedChunk,
      sendMessageParams as Record<string, never>,
    );
    messageIds.push(result.message_id);
  }

  return messageIds;
}

/**
 * Send a typing indicator to a Telegram chat.
 */
export async function sendTypingIndicator(encryptedToken: string, chatId: bigint): Promise<void> {
  const bot = createBot(encryptedToken);
  // Fire-and-forget — errors are logged but don't break the flow
  bot.api.sendChatAction(Number(chatId), "typing").catch((err) => {
    console.error("Failed to send typing indicator:", err);
  });
}

/**
 * Escape special characters for Telegram's MarkdownV2 parse mode.
 * Preserves intentional formatting (bold, italic, code, links) while escaping
 * other occurrences of special characters that would break parsing.
 *
 * MarkdownV2 requires escaping: _ * [ ] ( ) ~ ` > # + - = | { } . !
 */
function escapeMarkdownV2(text: string): string {
  const backtick = /`+/g;
  const strikethrough = /~~/g;
  const escapeChars = /[_*\[\]()~`>#+\-=|{}.!]/g;

  // Escape chars for link text (exclude [] which are link syntax)
  const escapeLinkTextChars = /[_*\]()~`>#+\-=|{}.!]/g;
  // Escape chars for URL (exclude () which are link syntax)
  const escapeUrlChars = /[_*\[\]~`>#+\-=|{}.!]/g;

  // Combined patterns: bold/italic wrapping links — must come BEFORE
  // standalone bold/italic patterns so the link inside is captured together
  // and its URL/link-text get escaped properly.
  const boldLink = /\*\*(\[([^\]]*?)\]\(([^)]*?)\))\*\*/g;
  const italicLink = /_(\[([^\]]*?)\]\(([^)]*?)\))_/g;
  const boldItalicLink = /\*\*\*(\[([^\]]*?)\]\(([^)]*?)\))\*\*\*/g;

  // Standalone patterns
  const boldItalic = /\*\*\*|___/g;
  const bold = /\*\*/g;
  const italic = /(?<!\*)\*(?!\*)|(?<!_)_(?!_)/g;
  const link = /\[([^\]]*?)\]\(([^)]*?)\)/g;

  /**
   * Escape special characters inside a link's text and URL while preserving
   * the `[text](url)` syntax and any surrounding formatting markers.
   */
  function buildEscapedLink(prefix: string, linkText: string, url: string, suffix: string): string {
    return `${prefix}[${linkText.replace(escapeLinkTextChars, "\\$&")}](${url.replace(escapeUrlChars, "\\$&")})${suffix}`;
  }

  const parts: string[] = [];
  let lastIndex = 0;

  // Build unified pattern: combined link patterns FIRST, then standalone
  const tokenPattern = new RegExp(
    `(?:${boldItalicLink.source}|${boldLink.source}|${italicLink.source}|${backtick.source}|${boldItalic.source}|${bold.source}|${italic.source}|${strikethrough.source}|${link.source})`,
    "g",
  );

  let match: RegExpExecArray | null;
  while ((match = tokenPattern.exec(text)) !== null) {
    // Escape the text between last match and this one
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index).replace(escapeChars, "\\$&"));
    }

    const fullMatch = match[0];

    // Handle combined bold-italic-link: ***[text](url)***
    if (fullMatch.startsWith("***") && fullMatch.endsWith("***")) {
      const inner = fullMatch.slice(3, -3);
      const m = inner.match(/^\[([^\]]*?)\]\(([^)]*?)\)$/);
      if (m) {
        parts.push(buildEscapedLink("***", m[1] ?? "", m[2] ?? "", "***"));
      } else {
        parts.push(fullMatch);
      }
    }
    // Handle combined bold-link: **[text](url)**
    else if (fullMatch.startsWith("**") && fullMatch.endsWith("**")) {
      const inner = fullMatch.slice(2, -2);
      const m = inner.match(/^\[([^\]]*?)\]\(([^)]*?)\)$/);
      if (m) {
        parts.push(buildEscapedLink("**", m[1] ?? "", m[2] ?? "", "**"));
      } else {
        parts.push(fullMatch);
      }
    }
    // Handle combined italic-link: _[text](url)_
    else if (fullMatch.startsWith("_") && fullMatch.endsWith("_")) {
      const inner = fullMatch.slice(1, -1);
      const m = inner.match(/^\[([^\]]*?)\]\(([^)]*?)\)$/);
      if (m) {
        parts.push(buildEscapedLink("_", m[1] ?? "", m[2] ?? "", "_"));
      } else {
        parts.push(fullMatch);
      }
    }
    // Handle standalone link: [text](url)
    else if (fullMatch.startsWith("[")) {
      const m = fullMatch.match(/^\[([^\]]*?)\]\(([^)]*?)\)$/);
      if (m) {
        parts.push(buildEscapedLink("", m[1] ?? "", m[2] ?? "", ""));
      } else {
        parts.push(fullMatch);
      }
    }
    // All other formatting tokens: keep as-is
    else {
      parts.push(fullMatch);
    }

    lastIndex = match.index + fullMatch.length;
  }

  // Escape any remaining text after the last match
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex).replace(escapeChars, "\\$&"));
  }

  return parts.join("");
}

/**
 * Split a message into chunks that fit within Telegram's 4096 character limit.
 * Tries to split at word boundaries to avoid cutting words in half.
 */
function splitMessage(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Find a good split point (at a space or newline)
    let splitAt = remaining.lastIndexOf(" ", maxLength);
    if (splitAt === -1) {
      splitAt = remaining.lastIndexOf("\n", maxLength);
    }
    if (splitAt === -1) {
      // No space found — force split at maxLength
      splitAt = maxLength;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  return chunks;
}
