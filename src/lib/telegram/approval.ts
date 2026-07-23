import { prisma } from "@/lib/db";
import { createBot } from "./client";
import type { ApprovalRequest } from "@/lib/pi/tool-approval-gate";

/**
 * Send a tool approval request via Telegram with inline buttons.
 *
 * Only sends if the user has an enabled Telegram bot configured.
 * The callback data encodes: approve:{sessionId}:{toolCallId} or deny:{sessionId}:{toolCallId}
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

  await bot.api.sendMessage(Number(chat.telegramChatId), text, {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "✅ Approve",
            callback_data: `approve:${request.sessionId}:${request.toolCallId}`,
          },
          {
            text: "❌ Deny",
            callback_data: `deny:${request.sessionId}:${request.toolCallId}`,
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
 * Verifies user isolation: the session must belong to the Telegram account's user.
 *
 * @returns true if the callback was handled, false if it was not an approval callback.
 */
export async function handleApprovalCallback(
  accountId: string,
  callbackData: string,
): Promise<{ handled: boolean; message?: string }> {
  if (!callbackData.startsWith("approve:") && !callbackData.startsWith("deny:")) {
    return { handled: false };
  }

  const [action, sessionId, toolCallId] = callbackData.split(":");
  if (!sessionId || !toolCallId) {
    return { handled: false };
  }

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

  const approved = action === "approve";

  // Import dynamically to avoid circular deps
  const { resolveApproval } = await import("@/lib/pi/tool-approval-gate");
  const resolved = await resolveApproval(sessionId, toolCallId, approved);

  return {
    handled: true,
    message: resolved
      ? approved
        ? "✅ Tool call approved."
        : "❌ Tool call denied."
      : "⚠️ Approval request not found (may have expired).",
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
