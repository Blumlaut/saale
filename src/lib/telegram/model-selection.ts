import { randomBytes } from "crypto";
import { prisma } from "@/lib/db";
import { getRedis } from "@/lib/redis";
import { buildModelRuntime } from "@/lib/pi/models";
import { resolveModelForPurpose } from "@/lib/pi/model-resolution";
import { createBot, sendTelegramMessage } from "./client";
import { ensureTelegramAgentDefinition } from "./processor";

/**
 * Telegram /model command — pick a model for the user's Telegram chats
 * via an inline keyboard (no typing model names by hand).
 *
 * The choice is stored on the system-managed "Telegram Assistant" agent
 * definition (`modelId`), which `processTelegramMessage` already reads as
 * its explicit override — so no changes to the run path are needed.
 *
 * Callback data format (kept under Telegram's 64-byte limit by using a
 * short token that points at the pick session stored in Redis):
 *   m:{token}:s:{index}  — select model at absolute index in the list
 *   m:{token}:p:{page}   — navigate to a page
 *   m:{token}:r          — revert to the user's default model
 */

/** Redis key prefix for in-flight model pick sessions. */
const MODEL_PICK_PREFIX = "saale:model-pick:";

/** How long a picker stays usable before the user must send /model again. */
const MODEL_PICK_TTL_S = 10 * 60;

/** Models shown per page (1 button per row — readable on mobile). */
const MODELS_PER_PAGE = 6;

/** Telegram message/chat location for editing the picker message. */
export interface ModelCallbackMessage {
  chat: { id: number };
  message_id: number;
}

/** A single model option offered by the picker. */
interface ModelOption {
  provider: string;
  id: string;
  name: string;
}

/** Pick session payload stored in Redis. */
interface ModelPickSession {
  /** Callback token (also part of the Redis key). */
  token: string;
  userId: string;
  models: ModelOption[];
  page: number;
}

const pickKey = (token: string) => `${MODEL_PICK_PREFIX}${token}`;

/** Escape text for Telegram HTML parse mode. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Build the inline keyboard for a page of the picker.
 * Buttons are 1 per row; model names get a provider prefix only when the
 * user has more than one provider configured (otherwise it's noise).
 */
function buildKeyboard(session: ModelPickSession, multipleProviders: boolean) {
  const totalPages = Math.max(Math.ceil(session.models.length / MODELS_PER_PAGE), 1);
  const page = Math.min(session.page, totalPages - 1);
  const start = page * MODELS_PER_PAGE;
  const slice = session.models.slice(start, start + MODELS_PER_PAGE);

  const rows: Array<Array<{ text: string; callback_data: string }>> = slice.map((m, i) => {
    const label = multipleProviders ? `${m.provider}:${m.name}` : m.name;
    return [
      {
        text: label,
        callback_data: `m:${session.token}:s:${start + i}`,
      },
    ];
  });

  // Pagination row (only when needed)
  if (totalPages > 1) {
    const nav: Array<{ text: string; callback_data: string }> = [];
    if (page > 0) {
      nav.push({ text: "◀️", callback_data: `m:${session.token}:p:${page - 1}` });
    }
    nav.push({ text: `${page + 1}/${totalPages}`, callback_data: `m:${session.token}:noop` });
    if (page < totalPages - 1) {
      nav.push({ text: "▶️", callback_data: `m:${session.token}:p:${page + 1}` });
    }
    rows.push(nav);
  }

  rows.push([
    {
      text: "↩️ Use default model",
      callback_data: `m:${session.token}:r`,
    },
  ]);

  return { inline_keyboard: rows };
}

/**
 * Send the model picker to a Telegram chat.
 */
export async function sendModelPicker(params: {
  userId: string;
  encryptedToken: string;
  telegramChatId: bigint;
  replyToMessageId?: number | undefined;
}): Promise<void> {
  const { userId, encryptedToken, telegramChatId, replyToMessageId } = params;

  // 1. Load the models available to this user (their configured providers).
  const { models } = await buildModelRuntime(userId);
  const options: ModelOption[] = models.map((m) => ({
    provider: m.provider,
    id: m.id,
    name: m.name,
  }));

  if (options.length === 0) {
    await sendTelegramMessage(
      encryptedToken,
      telegramChatId,
      "⚠️ No AI models are available. Add a provider API key in **Settings → AI & Models** first.",
      replyToMessageId != null ? { replyToMessageId } : undefined,
    );
    return;
  }

  // 2. Current selection (definition override, else the resolved default).
  const definition = await ensureTelegramAgentDefinition(userId);
  let currentLabel = "default";
  if (definition.modelId) {
    currentLabel = definition.modelId;
  } else {
    const resolved = await resolveModelForPurpose(userId, "telegram", null);
    if (resolved) {
      currentLabel = `${resolved.provider}:${resolved.name} (default)`;
    }
  }

  // 3. Store the pick session and send the picker message.
  const token = randomBytes(8).toString("hex"); // 16 hex chars
  const session: ModelPickSession = {
    token,
    userId,
    models: options,
    page: 0,
  };
  const redis = getRedis();
  redis.setex(pickKey(token), MODEL_PICK_TTL_S, JSON.stringify(session)).catch((err) => {
    console.error("Failed to store model pick session:", err);
  });

  const multipleProviders = new Set(options.map((m) => m.provider)).size > 1;
  const keyboard = buildKeyboard(session, multipleProviders);

  const text =
    `🤖 <b>Select a model for your Telegram chats</b>\n\n` +
    `<b>Current:</b> <code>${escapeHtml(currentLabel)}</code>\n` +
    `<i>This applies to all your Telegram chats. Send /model again to change it later.</i>`;

  const bot = createBot(encryptedToken);
  await bot.api.sendMessage(Number(telegramChatId), text, {
    parse_mode: "HTML",
    reply_markup: keyboard as never,
  });
}

/**
 * Handle a model-picker callback (inline button press on the /model message).
 *
 * Verifies user isolation: the pick session must belong to the Telegram
 * account's user. Edits the picker message in place (re-pages on nav,
 * confirmation on selection/reset) so no stale keyboards linger.
 *
 * @returns true if the callback was a model-picker callback, false otherwise.
 */
export async function handleModelCallback(
  accountId: string,
  callbackData: string,
  message?: ModelCallbackMessage,
): Promise<{ handled: boolean; message?: string }> {
  if (!callbackData.startsWith("m:")) {
    return { handled: false };
  }

  const parts = callbackData.split(":");
  if (parts.length < 3) return { handled: false };
  const [, token, action, value] = parts;
  if (!token || token.length !== 16) return { handled: false };

  const redis = getRedis();

  // Look up the pick session.
  const raw = await redis.get(pickKey(token));
  if (!raw) {
    return { handled: true, message: "⚠️ Model picker expired. Send /model again." };
  }
  const session = JSON.parse(raw) as ModelPickSession;

  // User isolation: the session must belong to the Telegram account's user.
  const account = await prisma.telegramAccount.findUnique({
    where: { id: accountId },
    select: { userId: true, encryptedToken: true },
  });
  if (!account || account.userId !== session.userId) {
    return { handled: false };
  }

  const bot = createBot(account.encryptedToken);

  const multipleProviders = new Set(session.models.map((m) => m.provider)).size > 1;
  const totalPages = Math.max(Math.ceil(session.models.length / MODELS_PER_PAGE), 1);

  const editPicker = async (text: string, keyboard: { inline_keyboard: unknown[] }) => {
    if (!message) return;
    await bot.api.editMessageText(message.chat.id, message.message_id, text, {
      parse_mode: "HTML",
      reply_markup: keyboard as never,
    });
  };

  // Navigation: re-render the requested page.
  if (action === "p" && value !== undefined) {
    const page = Math.min(Math.max(Number(value) || 0, 0), totalPages - 1);
    session.page = page;
    await redis.setex(pickKey(token), MODEL_PICK_TTL_S, JSON.stringify(session));
    const text =
      `🤖 <b>Select a model for your Telegram chats</b>\n\n` +
      `<i>Page ${page + 1} of ${totalPages}. Tap a model to select it.</i>`;
    await editPicker(text, buildKeyboard(session, multipleProviders));
    return { handled: true };
  }

  // Non-action button (page indicator) — just acknowledge.
  if (action === "noop") {
    return { handled: true };
  }

  // Find the telegram definition to persist the override.
  const definition = await ensureTelegramAgentDefinition(session.userId);

  // Reset to default.
  if (action === "r") {
    await prisma.agentDefinition.update({
      where: { id: definition.id },
      data: { modelId: null },
    });
    await redis.del(pickKey(token));
    await editPicker("↩️ Reverted to your default model.", { inline_keyboard: [] });
    return { handled: true, message: "↩️ Reverted to default model." };
  }

  // Select a model at an absolute index.
  if (action === "s" && value !== undefined) {
    const idx = Number(value);
    const model = Number.isInteger(idx) ? session.models[idx] : undefined;
    if (!model) {
      return { handled: true, message: "⚠️ Model not found. Send /model again." };
    }

    const modelId = `${model.provider}:${model.id}`;
    await prisma.agentDefinition.update({
      where: { id: definition.id },
      data: { modelId },
    });
    await redis.del(pickKey(token));
    await editPicker(
      `✅ <b>Model set</b> to <code>${escapeHtml(modelId)}</code> for your Telegram chats.`,
      { inline_keyboard: [] },
    );
    return { handled: true, message: `✅ Model set to ${modelId}.` };
  }

  return { handled: false };
}
