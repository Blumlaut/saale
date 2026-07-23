import { randomBytes } from "crypto";
import { prisma } from "@/lib/db";
import { getRedis } from "@/lib/redis";
import { createBot } from "./client";
import type { ApprovalRequest } from "@/lib/pi/tool-approval-gate";

/** Redis key prefix for short approval tokens. */
const TOKEN_KEY_PREFIX = "saale:approval-token:";

/**
 * Send a tool approval request via Telegram with inline buttons.
 *
 * Only sends if the user has an enabled Telegram bot configured.
 * Uses a short random token (stored in Redis) for callback_data
 * to stay within Telegram's 64-byte limit.
 */
export async function sendTelegramApprovalRequest(
  userId: string,
  request: ApprovalRequest,
): Promise<void> {
  const account = await prisma.telegramAccount.findFirst({
    where: { userId, enabled: true },
    select: { id: true, encryptedToken: true, userId: true },
  });

  if (!account) return;

  // Find the user's Telegram chat ID from TelegramChat records
  const chat = await prisma.telegramChat.findFirst({
    where: { telegramAccountId: account.id },
    select: { telegramChatId: true },
    orderBy: { updatedAt: "desc" },
  });

  if (!chat) return;

  const bot = createBot(account.encryptedToken);

  // Truncate args for display
  const argsPreview = formatArgsPreview(request.args);

  const text =
    `⚡ <b>Tool Approval Required</b>\n\n` +
    `<b>Tool:</b> <code>${escapeHtml(request.toolName)}</code>\n` +
    `<b>Session:</b> ${request.sessionId.slice(0, 8)}...\n\n` +
    (argsPreview ? `<code>${escapeHtml(argsPreview)}</code>\n\n` : "") +
    `<i>Approve or deny this tool call. It will auto-deny in 5 minutes.</i>`;

  // Generate a short token for callback_data (Telegram limit: 64 bytes)
  const token = randomBytes(8).toString("hex"); // 16 hex chars
  const ttlSeconds = Math.ceil((request.expiresAt - Date.now()) / 1000);

  // Store the mapping: token → { sessionId, toolCallId }
  const redis = getRedis();
  redis
    .setex(
      `${TOKEN_KEY_PREFIX}${token}`,
      Math.max(ttlSeconds + 60, 60),
      JSON.stringify({ sessionId: request.sessionId, toolCallId: request.toolCallId }),
    )
    .catch((err) => {
      console.error("Failed to store approval token in Redis:", err);
    });

  await bot.api.sendMessage(Number(chat.telegramChatId), text, {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "✅ Approve",
            callback_data: `a:${token}`,
          },
          {
            text: "❌ Deny",
            callback_data: `d:${token}`,
          },
        ],
      ],
    },
  });
}

/**
 * Handle a Telegram callback query (inline button press).
 * Resolves the pending approval.
 *
 * Callback data format: `a:{token}` or `d:{token}` (approve/deny).
 * The token is looked up in Redis to get the actual sessionId and toolCallId.
 *
 * Verifies user isolation: the session must belong to the Telegram account's user.
 *
 * @returns true if the callback was handled, false if it was not an approval callback.
 */
export async function handleApprovalCallback(
  accountId: string,
  callbackData: string,
  opts?: { deleteMessage?: () => Promise<void> },
): Promise<{ handled: boolean; message?: string; approved?: boolean }> {
  if (!callbackData.startsWith("a:") && !callbackData.startsWith("d:")) {
    return { handled: false };
  }

  const [action, token] = callbackData.split(":");
  if (!token || token.length !== 16) {
    return { handled: false };
  }

  const approved = action === "a";

  // Look up the token in Redis
  const redis = getRedis();
  const tokenData = await redis.get(`${TOKEN_KEY_PREFIX}${token}`);
  if (!tokenData) {
    return {
      handled: true,
      message: "⚠️ Approval request expired or not found.",
    };
  }

  // Clean up the token
  await redis.del(`${TOKEN_KEY_PREFIX}${token}`).catch((err) => {
    console.error("Failed to clean up approval token:", err);
  });

  const { sessionId, toolCallId } = JSON.parse(tokenData) as {
    sessionId: string;
    toolCallId: string;
  };

  // User isolation: verify the session belongs to the Telegram account's user
  const account = await prisma.telegramAccount.findUnique({
    where: { id: accountId },
    select: { userId: true },
  });

  if (!account) {
    return { handled: false };
  }

  const session = await prisma.chatSession.findUnique({
    where: { id: sessionId },
    select: { userId: true },
  });

  if (!session || session.userId !== account.userId) {
    return { handled: false };
  }

  // Import dynamically to avoid circular deps
  const { resolveApproval } = await import("@/lib/pi/tool-approval-gate");
  const resolved = await resolveApproval(sessionId, toolCallId, approved);

  const message = resolved
    ? approved
      ? "✅ Tool call approved."
      : "❌ Tool call denied."
    : "⚠️ Approval request not found (may have expired).";

  // Delete the approval message on approve so it doesn't clutter the chat
  if (approved && resolved && opts?.deleteMessage) {
    opts.deleteMessage().catch((err) => {
      console.error("Failed to delete approval message:", err);
    });
  }

  return {
    handled: true,
    message,
    approved: approved && resolved,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Format tool args into a short preview string. */
function formatArgsPreview(args: Record<string, unknown>): string {
  const entries = Object.entries(args);
  if (entries.length === 0) return "";

  return entries
    .map(([key, value]) => {
      const str = typeof value === "string" ? value : JSON.stringify(value);
      return `${key}=${str.slice(0, 80)}`;
    })
    .join("\n");
}

/** Escape HTML special characters for Telegram HTML mode. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
