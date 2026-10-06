import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import {
  processTelegramMessage,
  compactTelegramSession,
  isWhitelisted,
  upsertWhitelistDisplayName,
} from "@/lib/telegram/processor";
import type { TelegramFileInfo } from "@/lib/telegram/files";
import { createBot, sendTelegramMessage } from "@/lib/telegram/client";
import { handleApprovalCallback } from "@/lib/telegram/approval";
import { handleModelCallback, sendModelPicker } from "@/lib/telegram/model-selection";
import { enableAutoApprove, disableAutoApprove, STFU_DURATION_MS } from "@/lib/pi/auto-approve";
import {
  attachTelegramSession,
  interruptTelegramChat,
  nextMessageSeq,
} from "@/lib/telegram/session-registry";

/**
 * Match a Telegram command like `/model`, `/model@BotName`, or `/model arg`.
 * The optional @botname suffix is stripped by Telegram when the bot is the
 * only one in the chat; handle both forms defensively.
 */
function isCommand(text: string, command: string): boolean {
  return text === command || text.startsWith(`${command}@`) || text.startsWith(`${command} `);
}

/**
 * Extract the message a user is quote-replying to, if any.
 *
 * Telegram includes the full replied-to message, so this gives the agent the
 * exact context even when the original was sent by a job (which lives outside
 * the chat's Pi session) or before a session rollover.
 */
function extractQuotedMessage(reply: unknown):
  | { messageId: number; text: string; fromBot: boolean; fromName: string }
  | undefined {
  if (!reply || typeof reply !== "object") return undefined;
  const r = reply as {
    message_id?: number;
    text?: string;
    caption?: string;
    from?: { first_name?: string; username?: string; is_bot?: boolean };
  };
  const text = r.text ?? r.caption;
  if (!text || typeof r.message_id !== "number") return undefined;
  return {
    messageId: r.message_id,
    text,
    fromBot: r.from?.is_bot === true,
    fromName: r.from?.first_name ?? r.from?.username ?? "unknown",
  };
}

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

    // Handle approval callbacks (with accountId for user isolation).
    // The approval card is deleted by the run's card tracker when the
    // resolution event reaches it.
    const result = await handleApprovalCallback(accountId, callbackQuery.data);
    if (result.handled && result.message) {
      try {
        await bot.api.answerCallbackQuery(callbackQuery.id, {
          text: result.message,
          show_alert: false,
        });
      } catch (err) {
        console.error("Failed to answer callback query:", err);
      }
    } else if (!result.handled) {
      // Not an approval callback — try the /model picker callback.
      const modelResult = await handleModelCallback(
        accountId,
        callbackQuery.data,
        callbackQuery.message,
      );
      if (modelResult.handled && modelResult.message) {
        try {
          await bot.api.answerCallbackQuery(callbackQuery.id, {
            text: modelResult.message,
            show_alert: false,
          });
        } catch (err) {
          console.error("Failed to answer model callback query:", err);
        }
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
        reply_to_message?: unknown;
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

  // 7.5. Handle commands
  // /compact — compact the current chat session
  if (isCommand(content.text ?? "", "/compact")) {
    compactTelegramSession({
      userId: account.userId,
      encryptedToken: account.encryptedToken,
      telegramChatId,
      replyToMessageId: message.message_id,
    }).catch((err) => {
      console.error("Telegram /compact command failed:", err);
    });
    return NextResponse.json({ ok: true });
  }

  // /model — inline-keyboard picker for the user's Telegram model
  if (isCommand(content.text ?? "", "/model")) {
    sendModelPicker({
      userId: account.userId,
      encryptedToken: account.encryptedToken,
      telegramChatId,
      replyToMessageId: message.message_id,
    }).catch((err) => {
      console.error("Telegram /model command failed:", err);
    });
    return NextResponse.json({ ok: true });
  }

  // /stfu — auto-accept ALL tool use requests that require approval for 2
  // hours, regardless of per-tool "ask"/"auto" preferences. Tools disabled
  // with the "off" policy stay disabled. /stfu stop cancels early.
  const stfuText = content.text ?? "";
  if (isCommand(stfuText, "/stfu")) {
    const reply = { replyToMessageId: message.message_id } as const;
    // Strip the command and any @botname suffix to get the argument.
    const stfuArg = stfuText.replace(/^\/stfu(@\w+)?/, "").trim();
    if (stfuArg === "stop") {
      disableAutoApprove(account.userId)
        .then(() =>
          sendTelegramMessage(
            account.encryptedToken,
            telegramChatId,
            "✅ STFU mode cancelled. Tool approvals are back to your normal policies.",
            reply,
          ),
        )
        .catch((err) => {
          console.error("Telegram /stfu stop failed:", err);
        });
    } else if (stfuArg !== "") {
      sendTelegramMessage(
        account.encryptedToken,
        telegramChatId,
        "Usage: /stfu (auto-approve all tool calls for 2h) or /stfu stop (cancel).",
        reply,
      ).catch((err) => {
        console.error("Telegram /stfu usage reply failed:", err);
      });
    } else {
      enableAutoApprove(account.userId, STFU_DURATION_MS)
        .then((until) => {
          const time = new Date(until).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          });
          return sendTelegramMessage(
            account.encryptedToken,
            telegramChatId,
            `🤐 STFU mode ON for 2 hours — tool approvals are auto-accepted until ${time}, ` +
              `regardless of your ask/auto preferences. Tools you've disabled stay off. ` +
              `Send /stfu stop to cancel.`,
            reply,
          );
        })
        .catch((err) => {
          console.error("Telegram /stfu command failed:", err);
        });
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

  // 10. Latest message wins: this message replaces any in-flight run for the
  //     chat. Bump the chat's message sequence, then supersede the active run
  //     (aborting the live session if the Pi session exists yet) and wait for
  //     it to settle before the new run starts.
  const messageSeq = nextMessageSeq(account.userId, telegramChatId);
  await interruptTelegramChat(account.userId, telegramChatId);

  // 11. Process the message asynchronously with run tracking for interruption.
  //     The done promise settles when the run has fully settled (success,
  //     error, abort, or supersession), so interruptTelegramChat() knows when
  //     to stop waiting.
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
    replyToQuoted: extractQuotedMessage(message.reply_to_message),
    messageSeq,
    donePromise: processingPromise,
    onSessionCreated: (session, tgChatId) => {
      attachTelegramSession(account.userId, tgChatId, session);
    },
    processingDone,
  }).catch((err) => {
    console.error("Telegram message processing failed:", err);
  });

  // 12. Acknowledge receipt immediately
  return NextResponse.json({ ok: true });
}
