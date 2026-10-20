import { randomBytes } from "crypto";
import { prisma } from "@/lib/db";
import { getRedis } from "@/lib/redis";
import { findToolInfo, summarizeToolAction } from "@/lib/pi/tool-infos";
import { createBot } from "./client";
import { getEnabledTelegramBot } from "./bot";
import { getLinkByTelegramUserId, getLinkByUserId } from "./links";
import type { ApprovalRequest } from "@/lib/pi/tool-approval-gate";
import type { ApprovalCardId } from "./approval-cards";

/** Redis key prefix for short approval tokens. */
const TOKEN_KEY_PREFIX = "saale:approval-token:";

/**
 * Send a tool approval request via Telegram with inline buttons.
 *
 * Only sends if the instance has an enabled bot and the user has linked their
 * Telegram account. Uses a short random token (stored in Redis) for
 * callback_data to stay within Telegram's 64-byte limit.
 *
 * @returns The card's chat + message IDs (so the sender can delete it
 *          later), or null if no card was sent.
 */
export async function sendTelegramApprovalRequest(
  userId: string,
  request: ApprovalRequest,
): Promise<ApprovalCardId | null> {
  const botConfig = await getEnabledTelegramBot();
  if (!botConfig) return null;

  const link = await getLinkByUserId(userId);
  if (!link) return null;

  const bot = createBot(botConfig.encryptedToken);

  // What the call is about: the server-resolved summary (ID references
  // looked up against the user's records), falling back to the client-safe
  // argument summary for requests predating the field.
  const label = findToolInfo(request.toolName)?.label ?? request.toolName;
  const summary = request.summary ?? summarizeToolAction(request.toolName, request.args);

  // The calls one decision stands in for. A script's approval covers the calls
  // it announced, so the card names them: the user is deciding on those.
  const covered = (request.batch?.tools ?? []).map((name) => findToolInfo(name)?.label ?? name);

  // Truncate args for display
  const argsPreview = formatArgsPreview(request.args);

  const text =
    `⚡ <b>Approval required</b>\n\n` +
    `<b>${escapeHtml(label)}</b>` +
    (summary ? `: <b>${escapeHtml(summary)}</b>` : "") +
    (covered.length > 0
      ? `\n\n<b>One approval covers:</b> ${escapeHtml(covered.join(", "))}` +
        (request.batch?.dynamic
          ? `\n<i>It can also call tools by name. those ask on their own.</i>`
          : "")
      : "") +
    `\n\n<code>${escapeHtml(request.toolName)}</code> · session ${request.sessionId.slice(0, 8)}...\n\n` +
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

  const sent = await bot.api.sendMessage(Number(link.telegramChatId), text, {
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

  return { chatId: Number(link.telegramChatId), messageId: sent.message_id };
}

/**
 * Delete a previously sent approval card.
 *
 * Deletion is owned by the run that sent the card (see
 * createApprovalCardTracker). the card goes away when the approval
 * resolves on ANY path (Telegram button, web UI, timeout, interrupt).
 */
export async function deleteTelegramApprovalMessage(
  encryptedToken: string,
  cardId: ApprovalCardId,
): Promise<void> {
  const bot = createBot(encryptedToken);
  await bot.api.deleteMessage(cardId.chatId, cardId.messageId);
}

/**
 * Handle a Telegram callback query (inline button press).
 * Resolves the pending approval.
 *
 * Callback data format: `a:{token}` or `d:{token}` (approve/deny).
 * The token is looked up in Redis to get the actual sessionId and toolCallId.
 *
 * User isolation: the press must come from the Telegram account linked to the
 * user who owns the session. One bot serves every user, so the card's presence
 * proves nothing. a forwarded message keeps its buttons, and without this
 * check any user of the bot could resolve someone else's approval. The
 * `telegramUserId` comes from Telegram's own callback payload, not from
 * anything the sender can forge.
 *
 * The approval card itself is deleted by the run's card tracker (which
 * observes the `tool_approval_resolved` session bus event this resolution
 * publishes). not here. so every resolution path removes the card.
 *
 * @returns true if the callback was handled, false if it was not an approval callback.
 */
export async function handleApprovalCallback(
  callbackData: string,
  telegramUserId: bigint,
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

  const { sessionId, toolCallId } = JSON.parse(tokenData) as {
    sessionId: string;
    toolCallId: string;
  };

  // User isolation: the pressing Telegram account must be the one linked to the
  // session's owner. The token is only consumed once that holds.
  const [link, session] = await Promise.all([
    getLinkByTelegramUserId(telegramUserId),
    prisma.chatSession.findUnique({
      where: { id: sessionId },
      select: { userId: true },
    }),
  ]);

  if (!link || !session || session.userId !== link.userId) {
    return {
      handled: true,
      message: "⚠️ This approval belongs to a different account.",
    };
  }

  // Clean up the token
  await redis.del(`${TOKEN_KEY_PREFIX}${token}`).catch((err) => {
    console.error("Failed to clean up approval token:", err);
  });

  // Import dynamically to avoid circular deps
  const { resolveApproval } = await import("@/lib/pi/tool-approval-gate");
  const resolved = await resolveApproval(sessionId, toolCallId, approved);

  const message = resolved
    ? approved
      ? "✅ Tool call approved."
      : "❌ Tool call denied."
    : "⚠️ Approval request not found (may have expired).";

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
