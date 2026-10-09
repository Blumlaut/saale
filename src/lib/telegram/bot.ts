import crypto from "crypto";
import { prisma } from "@/lib/db";
import { encrypt } from "@/lib/crypto";
import { deleteWebhook, registerWebhook, validateBotToken } from "./client";

/**
 * The shared Telegram bot — one per Saale instance, configured by an admin.
 *
 * Users no longer bring their own bot; they link their Telegram account to
 * this one (see `links.ts`). That means the token is instance-wide
 * infrastructure rather than a user preference: it is readable only through
 * the admin-gated route, never returned by the user-facing one, and stored
 * encrypted at rest like every other credential.
 */

/** The `TelegramBot` row's id. There is exactly one, so it has a fixed id. */
export const TELEGRAM_BOT_ID = "global";

export interface TelegramBotConfig {
  id: string;
  encryptedToken: string;
  enabled: boolean;
  botId: bigint | null;
  botUsername: string | null;
  webhookSecret: string;
  updatedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** The configured bot, whether or not it is enabled. */
export async function getTelegramBot(): Promise<TelegramBotConfig | null> {
  return prisma.telegramBot.findUnique({ where: { id: TELEGRAM_BOT_ID } });
}

/** The configured bot, only when it is switched on. */
export async function getEnabledTelegramBot(): Promise<TelegramBotConfig | null> {
  const bot = await getTelegramBot();
  return bot?.enabled ? bot : null;
}

export interface SaveTelegramBotResult {
  bot: TelegramBotConfig;
  /**
   * Telegram's `setWebhook` answering our call. False means the token and bot
   * identity are stored but updates will not arrive until a later
   * registration succeeds (the worker retries on startup).
   */
  webhookRegistered: boolean;
}

/**
 * Store the bot token and publish the webhook.
 *
 * The token is validated against Telegram's `getMe` first — an invalid token
 * would leave the instance with a bot that can never receive a message, and
 * the admin would find out only by messaging it.
 *
 * The config is persisted before the webhook is registered: if registration
 * fails, the stored secret is the one the worker will register on its next
 * startup, so the pair nobody can reconcile is never left active.
 */
export async function saveTelegramBot(params: {
  token: string;
  adminUserId: string;
}): Promise<SaveTelegramBotResult> {
  const { token, adminUserId } = params;

  const botInfo = await validateBotToken(token);
  const webhookSecret = crypto.randomBytes(32).toString("hex");

  const bot = await prisma.telegramBot.upsert({
    where: { id: TELEGRAM_BOT_ID },
    create: {
      id: TELEGRAM_BOT_ID,
      encryptedToken: encrypt(token),
      botId: botInfo.botId,
      botUsername: botInfo.botUsername,
      webhookSecret,
      enabled: true,
      updatedByUserId: adminUserId,
    },
    update: {
      encryptedToken: encrypt(token),
      botId: botInfo.botId,
      botUsername: botInfo.botUsername,
      webhookSecret,
      enabled: true,
      updatedByUserId: adminUserId,
    },
  });

  let webhookRegistered: boolean;
  try {
    webhookRegistered = await registerWebhook(bot.encryptedToken, bot.webhookSecret);
  } catch (err) {
    console.error("Failed to register the shared Telegram webhook:", err);
    webhookRegistered = false;
  }

  return { bot, webhookRegistered };
}

/**
 * Switch the bot on or off.
 *
 * Turning it off deletes the webhook, so Telegram stops delivering updates
 * rather than us rejecting them one by one. Links are kept — an admin pausing
 * the bot must not silently unlink every user.
 */
export async function setTelegramBotEnabled(enabled: boolean): Promise<TelegramBotConfig> {
  const bot = await prisma.telegramBot.update({
    where: { id: TELEGRAM_BOT_ID },
    data: { enabled },
  });

  await (
    enabled
      ? registerWebhook(bot.encryptedToken, bot.webhookSecret)
      : deleteWebhook(bot.encryptedToken)
  ).catch((err) => {
    console.error(`Failed to ${enabled ? "register" : "delete"} the shared Telegram webhook:`, err);
  });

  return bot;
}

/**
 * Remove the bot entirely.
 *
 * Cascades every link and pending code: with no bot there is nothing to talk
 * to, so leaving links behind would only mislead the users who hold them.
 */
export async function removeTelegramBot(): Promise<boolean> {
  const bot = await getTelegramBot();
  if (!bot) return false;

  await deleteWebhook(bot.encryptedToken).catch((err) => {
    console.error("Failed to delete the shared Telegram webhook during removal:", err);
  });

  await prisma.telegramBot.delete({ where: { id: TELEGRAM_BOT_ID } });
  return true;
}

/**
 * Re-publish the webhook on worker startup.
 *
 * `setWebhook` state lives on Telegram's side, so a restart (or a deploy that
 * moved the app to a new URL) leaves no record here of whether it still
 * points at us. Registering once at boot makes the stored config
 * authoritative again.
 */
export async function registerTelegramWebhook(): Promise<void> {
  const bot = await getEnabledTelegramBot();
  if (!bot) return;

  await registerWebhook(bot.encryptedToken, bot.webhookSecret);
}
