import { createBot, sendTelegramMessage } from "./client";
import { resolveTelegramTarget } from "./routing";
import { runRoutedTelegramMessage } from "./routed-run";
import { buildQuotedContext, type QuotedMessageContext } from "./reply-context";
import { beginTelegramRun, clearTelegramRun, isLatestMessage } from "./session-registry";
import {
  downloadAndProcessTelegramFile,
  buildFilePromptText,
  type ProcessedFile,
  type TelegramFileInfo,
} from "./files";
import { withChatLock } from "./chat-lock";
import { setActiveTelegramSession } from "./links";

/**
 * What the bot says to a message that continues no conversation.
 *
 * Telegram is a transport into ordinary chats, so there is no chat of the bot's
 * own to fall back to. A message that answers nothing has nowhere to run.
 */
export const NO_CHAT_MESSAGE =
  "This message doesn't belong to a chat. Send /new to start one, or reply to a message I sent you.";

/**
 * Process an incoming Telegram message.
 *
 * The message runs in the Saale chat it continues, on that chat's own pooled
 * agent, so the phone and the browser share one transcript. Photos are passed to
 * the vision model, and documents are saved into the chat's workspace and named
 * in the prompt.
 */
export async function processTelegramMessage(params: ProcessTelegramMessageParams): Promise<void> {
  // One run per chat: two overlapping runs share a transcript directory and can
  // both create the chat's session (see `withChatLock`). Latest message wins
  // a run superseded by a newer message bails out at its checkpoints instead
  // of running to completion (see `isLatestMessage`).
  return withChatLock(`${params.userId}:${params.telegramChatId}`, async () => {
    try {
      await runTelegramMessage(params);
    } finally {
      // The run is fully settled (success, error, abort, or supersession).
      // interruptTelegramChat() awaits this promise, so every exit path
      // including a setup failure before the run registers. must resolve it.
      params.processingDone?.resolve();
    }
  });
}

interface ProcessTelegramMessageParams {
  processingDone?: { resolve: () => void };
  /** This message's sequence for its chat. the run drops out if a newer message supersedes it. */
  messageSeq: number;
  /** Settles when this run has fully settled. registered for interrupt waits. */
  donePromise?: Promise<void>;
  userId: string;
  encryptedToken: string;
  telegramChatId: bigint;
  telegramUserId: bigint;
  messageText: string;
  messageCaption?: string | undefined;
  fileInfo?: TelegramFileInfo | undefined;
  messageThreadId?: number | undefined;
  replyToMessageId?: number | undefined;
  /** The message the user quote-replied to, when they used Telegram's reply feature. */
  replyToQuoted?: QuotedMessageContext | undefined;
}
/** The body of `processTelegramMessage`, run exclusively per chat. */
async function runTelegramMessage(params: ProcessTelegramMessageParams): Promise<void> {
  const {
    userId,
    encryptedToken,
    telegramChatId,
    messageText,
    messageCaption,
    fileInfo,
    replyToMessageId,
    replyToQuoted,
    messageSeq,
    donePromise,
  } = params;

  // Register this run as the chat's active run BEFORE the slow setup below.
  // an incoming message must be able to supersede the run even while the Pi
  // session does not exist yet.
  beginTelegramRun(userId, telegramChatId, donePromise ?? new Promise<void>(() => {}));

  // Latest message wins: a newer message for this chat arrived while we were
  // waiting for the chat lock. Drop this run before doing any work.
  if (!isLatestMessage(userId, telegramChatId, messageSeq)) {
    console.warn(
      `Dropping superseded Telegram message (seq ${messageSeq}, msg ${replyToMessageId}, chat ${telegramChatId})`,
    );
    clearTelegramRun(userId, telegramChatId);
    return;
  }

  // 1. Which chat does this message continue? A reply goes back to the chat
  //    that sent the message it answers, otherwise to the chat this
  //    conversation is in.
  const target = await resolveTelegramTarget({
    userId,
    telegramChatId,
    replyToMessageId: replyToQuoted ? BigInt(replyToQuoted.messageId) : null,
  });

  if (!target) {
    clearTelegramRun(userId, telegramChatId);
    await sendTelegramMessage(encryptedToken, telegramChatId, NO_CHAT_MESSAGE, {
      ...(replyToMessageId != null ? { replyToMessageId } : {}),
      parseMode: "HTML",
    }).catch((err) => {
      console.error("Failed to tell Telegram there is no chat for the message:", err);
    });
    return;
  }

  // Remember where this conversation is, so the next message that answers
  // nothing continues the same chat.
  await setActiveTelegramSession(userId, target.sessionId).catch((err) => {
    console.error(`Failed to remember the active Telegram chat for ${userId}:`, err);
  });

  // 2. Download and process any attached file
  let processedFile: ProcessedFile | undefined;
  let promptText = messageText || messageCaption || "";

  if (fileInfo) {
    const telegramBot = createBot(encryptedToken);

    try {
      processedFile = await downloadAndProcessTelegramFile(telegramBot, userId, fileInfo);
    } catch (err) {
      console.error(`Failed to download Telegram file:`, err);
      // Continue without the file. the text/caption is still processed
    }
  }

  // Build final prompt text (caption + file description for media messages)
  if (processedFile) {
    const filePromptText = buildFilePromptText(processedFile);
    promptText = promptText ? `${promptText}\n${filePromptText}` : filePromptText;
  }

  // The agent prompt adds any quote-reply context; the stored user message
  // stays the user's own text so the web UI mirrors the Telegram thread.
  const quotedContext = buildQuotedContext(replyToQuoted);
  const agentPrompt = quotedContext ? `${quotedContext}\n\n${promptText}` : promptText;

  // 3. Run it on that chat's own pooled agent, the same one the web UI
  //    prompts, so both surfaces share one transcript and one set of settings.
  await runRoutedTelegramMessage({
    userId,
    encryptedToken,
    telegramChatId,
    sessionId: target.sessionId,
    promptText,
    agentPrompt,
    ...(processedFile?.imageData ? { imageData: processedFile.imageData } : {}),
    ...(processedFile?.filePath ? { document: processedFile } : {}),
    ...(replyToMessageId != null ? { replyToMessageId } : {}),
    messageSeq,
    donePromise: donePromise ?? new Promise<void>(() => {}),
  });
}
