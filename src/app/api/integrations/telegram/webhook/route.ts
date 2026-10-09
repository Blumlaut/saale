import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  buildLinkFailureMessage,
  buildLinkRequiredMessage,
  buildLinkSuccessMessage,
  createBot,
} from "@/lib/telegram/client";
import { getTelegramBot } from "@/lib/telegram/bot";
import {
  LINK_CODE_PATTERN,
  consumeLinkCode,
  getLinkByTelegramUserId,
  updateLinkDisplayName,
} from "@/lib/telegram/links";
import { processTelegramMessage } from "@/lib/telegram/processor";
import type { TelegramFileInfo } from "@/lib/telegram/files";
import { handleApprovalCallback } from "@/lib/telegram/approval";
import { handleCommandPromptCallback, handleTelegramCommand } from "@/lib/telegram/command-prompts";
import { extractQuotedMessage } from "@/lib/telegram/reply-context";
import { getCommandMeta } from "@/lib/commands/catalog";
import { parseCommand } from "@/lib/commands/parse";
import {
  attachTelegramSession,
  interruptTelegramChat,
  nextMessageSeq,
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
 * Read a `/start` (or `/link`) deep-link payload from a message.
 *
 * Returns the payload — empty string for a bare `/start` — or null when the
 * message is not one of those commands.
 */
function parseLinkPayload(text: string): string | null {
  const match = /^\/(?:start|link)(?:\s+(\S+))?$/i.exec(text.trim());
  if (!match) return null;
  return match[1] ?? "";
}

/** The sender's display name from a Telegram `from` object. */
function senderDisplayName(from: { first_name?: string; last_name?: string }): string | null {
  const name = [from.first_name, from.last_name].filter(Boolean).join(" ").trim();
  return name || null;
}

/**
 * POST /api/integrations/telegram/webhook
 *
 * Receives Telegram updates for the instance's shared bot.
 *
 * Security:
 * - The webhookSecret is verified via Telegram's X-Telegram-Bot-Api-Secret-Token header
 * - The sender's Telegram user ID is the *only* input that selects a Saale
 *   account: it is matched against TelegramLink, and an unlinked sender is
 *   refused. Nothing in the message body can name a different account.
 * - Inline button presses are verified against the same link, because a
 *   forwarded card keeps its buttons and one bot now serves every user.
 * - Only private chats are processed — a shared, discoverable bot in a group
 *   would run one member's message against another member's account in front
 *   of everyone.
 */
export async function POST(request: NextRequest) {
  // 1. The instance's bot must exist and be switched on
  const botConfig = await getTelegramBot();

  if (!botConfig) {
    return NextResponse.json({ error: "Telegram is not configured" }, { status: 404 });
  }

  if (!botConfig.enabled) {
    return NextResponse.json({ error: "Telegram integration is disabled" }, { status: 403 });
  }

  // 2. Verify the webhook secret (Telegram sends this in a header)
  const incomingSecret = request.headers.get("x-telegram-bot-api-secret-token");
  if (incomingSecret !== botConfig.webhookSecret) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // 3. Parse the update
  let update: Record<string, unknown>;
  try {
    update = await request.json();
  } catch (err) {
    console.error("Failed to parse Telegram update body:", err);
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { encryptedToken } = botConfig;

  // 4. Handle callback queries (inline button presses — tool approval, command prompts)
  const callbackQuery = update.callback_query as
    | {
        id: string;
        data?: string;
        from?: { id: number; first_name?: string; last_name?: string };
        message: { chat: { id: number; type: string }; message_id: number };
      }
    | undefined;

  if (callbackQuery && callbackQuery.data) {
    // Without the presser we cannot tell whose decision this is, and guessing
    // would be exactly the cross-account leak this design exists to prevent.
    if (!callbackQuery.from) {
      console.error("Telegram callback query arrived without a sender — ignoring it");
      return NextResponse.json({ ok: true });
    }

    const presserId = BigInt(callbackQuery.from.id);
    const bot = createBot(encryptedToken);
    const answer = async (text: string, context: string) => {
      try {
        await bot.api.answerCallbackQuery(callbackQuery.id, { text, show_alert: false });
      } catch (err) {
        console.error(`Failed to answer ${context} callback query:`, err);
      }
    };

    // The approval card is deleted by the run's card tracker when the
    // resolution event reaches it.
    const approvalResult = await handleApprovalCallback(callbackQuery.data, presserId);
    if (approvalResult.handled) {
      if (approvalResult.message) await answer(approvalResult.message, "approval");
    } else {
      // Not an approval callback — try a slash-command prompt's button.
      const commandResult = await handleCommandPromptCallback(
        callbackQuery.data,
        presserId,
        callbackQuery.message,
      );
      if (commandResult.handled && commandResult.message)
        await answer(commandResult.message, "command");
    }

    return NextResponse.json({ ok: true });
  }

  // 5. Extract message from update (private chats only)
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
  const bot = createBot(encryptedToken);

  const reply = async (text: string) => {
    try {
      await bot.api.sendMessage(message.chat.id, text, { parse_mode: "HTML" });
    } catch (err) {
      console.error("Failed to send a Telegram reply:", err);
    }
  };

  // 6. Linking. `/start <code>` arrives from the deep link (or as `/link` typed
  //    on another device) and is the *only* way a link is created. It must be
  //    handled before the link check — redeeming a code is what an unlinked
  //    user is here to do.
  const linkPayload = parseLinkPayload(content.text ?? "");
  if (linkPayload !== null) {
    if (linkPayload === "") {
      await reply(buildLinkRequiredMessage());
      return NextResponse.json({ ok: true });
    }

    const result = LINK_CODE_PATTERN.test(linkPayload)
      ? await consumeLinkCode({
          code: linkPayload,
          telegramUserId,
          telegramChatId,
          displayName: senderDisplayName(message.from),
        })
      : ({ ok: false, reason: "expired" } as const);

    await reply(result.ok ? buildLinkSuccessMessage() : buildLinkFailureMessage(result.reason));
    return NextResponse.json({ ok: true });
  }

  // 7. Resolve the sender's Saale account. Unlinked senders are refused here —
  //    there is no path from a message to an account other than this lookup.
  const link = await getLinkByTelegramUserId(telegramUserId);
  if (!link) {
    await reply(buildLinkRequiredMessage());
    return NextResponse.json({ ok: true });
  }

  const userId = link.userId;

  // 8. Slash commands — declared once in the shared registry and dispatched
  //    through it, so a command behaves identically here and in the web chat.
  //    Only names the registry knows are intercepted; anything else (including
  //    paths like `/dashboard/chat`) still reaches the agent as a normal message.
  const parsedCommand = parseCommand(content.text ?? "");
  if (parsedCommand && getCommandMeta(parsedCommand.name)) {
    handleTelegramCommand({
      userId,
      encryptedToken,
      telegramChatId,
      name: parsedCommand.name,
      args: parsedCommand.args,
      replyToMessageId: message.message_id,
    }).catch((err) => {
      console.error(`Telegram /${parsedCommand.name} failed:`, err);
    });
    return NextResponse.json({ ok: true });
  }

  // 9. Update the cached display name (fire-and-forget)
  updateLinkDisplayName(telegramUserId, senderDisplayName(message.from)).catch((err) => {
    console.error("Failed to update the Telegram link display name:", err);
  });

  // 10. Latest message wins: this message replaces any in-flight run for the
  //     chat. Bump the chat's message sequence, then supersede the active run
  //     (aborting the live session if the Pi session exists yet) and wait for
  //     it to settle before the new run starts.
  const messageSeq = nextMessageSeq(userId, telegramChatId);
  await interruptTelegramChat(userId, telegramChatId);

  // 11. Process the message asynchronously with run tracking for interruption.
  //     The done promise settles when the run has fully settled (success,
  //     error, abort, or supersession), so interruptTelegramChat() knows when
  //     to stop waiting.
  const processingDone = { resolve: () => {} } as { resolve: () => void };
  const processingPromise = new Promise<void>((resolve) => {
    processingDone.resolve = resolve;
  });

  processTelegramMessage({
    userId,
    encryptedToken,
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
      attachTelegramSession(userId, tgChatId, session);
    },
    processingDone,
  }).catch((err) => {
    console.error("Telegram message processing failed:", err);
  });

  // 12. Acknowledge receipt immediately
  return NextResponse.json({ ok: true });
}
