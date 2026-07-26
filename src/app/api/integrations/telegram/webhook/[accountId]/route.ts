import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import {
  processTelegramMessage,
  isWhitelisted,
  upsertWhitelistDisplayName,
  type TelegramFileInfo,
} from "@/lib/telegram/processor";
import { createBot } from "@/lib/telegram/client";
import { handleApprovalCallback } from "@/lib/telegram/approval";
import {
  isTelegramSessionActive,
  registerTelegramSession,
  abortTelegramSession,
} from "@/lib/telegram/session-registry";

/**
 * Extract processable content from a Telegram message.
 * Handles text, photo, and document messages.
 */
function extractMessageContent(message: Record<string, unknown>): {
  text?: string | undefined;
  caption?: string | undefined;
  fileInfo?: TelegramFileInfo | undefined;
} | null {
  if (!message) return null;

  // Text messages
  if (message.text) {
    return { text: message.text as string };
  }

  // Photo messages — use the largest available size
  if (message.photo && Array.isArray(message.photo) && message.photo.length > 0) {
    const photos = message.photo as Array<{
      file_id: string;
      width: number;
      height: number;
      file_size?: number | undefined;
    }>;
    const largest = photos[photos.length - 1];
    if (!largest) return null;
    return {
      caption: (message.caption as string) ?? undefined,
      fileInfo: {
        fileId: largest.file_id,
        width: largest.width,
        height: largest.height,
        fileSize: largest.file_size ?? undefined,
        mimeType: "image/jpeg", // Telegram photos are always JPEG
      },
    };
  }

  // Document messages (files sent as documents)
  if (message.document) {
    const doc = message.document as {
      file_id: string;
      file_name?: string | undefined;
      mime_type?: string | undefined;
      file_size?: number | undefined;
      thumbnail?: { file_id: string; width: number; height: number };
    };
    return {
      caption: (message.caption as string) ?? undefined,
      fileInfo: {
        fileId: doc.file_id,
        fileName: doc.file_name ?? undefined,
        mimeType: doc.mime_type ?? undefined,
        fileSize: doc.file_size ?? undefined,
      },
    };
  }

  return null;
}

/**
 * POST /api/integrations/telegram/webhook/:accountId
 *
 * Receives Telegram updates via webhook. Each user's bot has its own
 * webhook URL pointing to their account ID, so we don't need to
 * disambiguate which bot received the update.
 *
 * Security:
 * - The accountId in the URL is a cuid() (not user-guessable)
 * - The account must exist and be enabled
 * - The webhookSecret is verified via Telegram's X-Telegram-Bot-Api-Secret-Token header
 * - Only whitelisted Telegram users can interact with the bot
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ accountId: string }> },
) {
  const { accountId } = await params;

  // 1. Look up the Telegram account (user-isolated via DB query)
  const account = await prisma.telegramAccount.findUnique({
    where: { id: accountId },
    select: {
      id: true,
      userId: true,
      encryptedToken: true,
      enabled: true,
      webhookSecret: true,
    },
  });

  if (!account) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // 2. Check if the integration is enabled
  if (!account.enabled) {
    return NextResponse.json({ error: "Telegram integration is disabled" }, { status: 403 });
  }

  // 3. Verify the webhook secret (Telegram sends this in a header)
  const incomingSecret = request.headers.get("x-telegram-bot-api-secret-token");
  if (incomingSecret !== account.webhookSecret) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // 4. Parse the update
  let update: Record<string, unknown>;
  try {
    update = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // 5. Handle callback queries (inline button presses — e.g. tool approval)
  const callbackQuery = update.callback_query as
    | {
        id: string;
        data?: string;
        message: { chat: { id: number; type: string }; message_id: number };
      }
    | undefined;

  if (callbackQuery && callbackQuery.data) {
    const bot = createBot(account.encryptedToken);

    // Build a delete callback bound to the approval message's chat and message IDs
    const approvalChatId = callbackQuery.message?.chat?.id;
    const approvalMessageId = callbackQuery.message?.message_id;
    const deleteApprovalMessage = async () => {
      if (approvalChatId != null && approvalMessageId != null) {
        await bot.api.deleteMessage(approvalChatId, approvalMessageId);
      }
    };

    // Handle approval callbacks (with accountId for user isolation)
    const result = await handleApprovalCallback(accountId, callbackQuery.data, {
      deleteMessage: deleteApprovalMessage,
    });
    if (result.handled && result.message) {
      try {
        await bot.api.answerCallbackQuery(callbackQuery.id, {
          text: result.message,
          show_alert: false,
        });
      } catch (err) {
        console.error("Failed to answer callback query:", err);
      }
    }

    return NextResponse.json({ ok: true });
  }

  // 6. Extract message from update (private chats only)
  const message = update.message as
    | {
        text?: string;
        caption?: string;
        photo?: unknown[];
        document?: unknown;
        chat: { id: number; type: string };
        from: { id: number; first_name?: string; last_name?: string };
        message_id: number;
      }
    | undefined;

  if (!message || message.chat.type !== "private") {
    return NextResponse.json({ ok: true });
  }

  // Extract content (text, photo, or document)
  const content = extractMessageContent(message);
  if (!content) {
    return NextResponse.json({ ok: true });
  }

  const telegramChatId = BigInt(message.chat.id);
  const telegramUserId = BigInt(message.from.id);

  // 7. Check whitelist
  const whitelisted = await isWhitelisted(account.id, telegramUserId);
  if (!whitelisted) {
    const bot = createBot(account.encryptedToken);
    try {
      await bot.api.sendMessage(
        message.chat.id,
        "You are not authorized to use this bot. Contact the owner to get access.",
        {
          parse_mode: "HTML",
        },
      );
    } catch (err) {
      console.error("Failed to send rejection message:", err);
    }
    return NextResponse.json({ ok: true });
  }

  // 8. Update display name cache (fire-and-forget)
  const displayName = [message.from.first_name, message.from.last_name].filter(Boolean).join(" ");
  upsertWhitelistDisplayName(account.id, telegramUserId, displayName || null).catch((err) => {
    console.error("Failed to update whitelist display name:", err);
  });

  // 9. Update last processed message ID (fire-and-forget)
  prisma.telegramChat
    .updateMany({
      where: {
        telegramAccountId: account.id,
        telegramChatId,
      },
      data: { lastMessageId: message.message_id },
    })
    .catch((err) => {
      console.error("Failed to update lastMessageId:", err);
    });

  // 10. If there's an ongoing generation, abort it before processing the new message.
  //     This ensures the user's latest message is processed immediately.
  if (isTelegramSessionActive(account.userId, telegramChatId)) {
    await abortTelegramSession(account.userId, telegramChatId);
  }

  // 11. Process the message asynchronously with session tracking for interruption.
  //     The processingDone promise resolves when generation completes (success, error, or abort),
  //     so abortAndAwait() knows when to stop waiting.
  const processingDone = { resolve: () => {} } as { resolve: () => void };
  const processingPromise = new Promise<void>((resolve) => {
    processingDone.resolve = resolve;
  });

  processTelegramMessage({
    userId: account.userId,
    encryptedToken: account.encryptedToken,
    telegramChatId,
    telegramUserId,
    messageText: content.text ?? "",
    messageCaption: content.caption,
    fileInfo: content.fileInfo,
    replyToMessageId: message.message_id,
    onSessionCreated: (session, tgChatId) => {
      registerTelegramSession(account.userId, tgChatId, session, processingPromise);
    },
    processingDone,
  }).catch((err) => {
    console.error("Telegram message processing failed:", err);
  });

  // 12. Acknowledge receipt immediately
  return NextResponse.json({ ok: true });
}
