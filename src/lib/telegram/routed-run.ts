import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { prisma } from "@/lib/db";
import { isSessionBusy } from "@/lib/redis";
import { get as getPoolEntry, getPoolKey } from "@/lib/pi/agent-pool";
import { beginChatRun, dispatchChatRun, ensureChatAgent } from "@/lib/chat/agent-run";
import { resolveChatModel } from "@/lib/pi/chat-session-factory";
import type { ImageContent } from "@/lib/pi/message-replay";
import { sendTelegramMessage, startTypingIndicator } from "./client";
import { createTelegramRunRenderer } from "./render";
import { recordTelegramDocumentAttachment, type ProcessedFile } from "./files";
import {
  attachTelegramSession,
  beginTelegramRun,
  isLatestMessage,
  unregisterTelegramSession,
} from "./session-registry";

/**
 * Run a Telegram message inside the chat that sent the message it answers.
 *
 * The chat's agent is the same pooled one the web UI prompts, so the message and
 * the reply appear in the open browser tab (`beginChatRun` publishes on the
 * session bus) and the conversation keeps its context. Everything that defines a
 * run lives in `@/lib/chat/agent-run`. this file only adds what a phone needs:
 * the typing indicator, the rendered messages, and the supersession rule.
 *
 * A chat that is already generating is refused rather than queued: the user is
 * waiting on a phone, and two runs over one transcript fight over it.
 */

export interface RoutedTelegramRunParams {
  userId: string;
  encryptedToken: string;
  telegramChatId: bigint;
  /** The chat the message continues. */
  sessionId: string;
  /** The user's own words, stored as the message. */
  promptText: string;
  /** The prompt the agent reads: `promptText` plus any quoted context. */
  agentPrompt: string;
  /** Base64 image from the message, already ready for the vision model. */
  imageData?: ImageContent | undefined;
  /** A document that was saved to the workspace and is named in the prompt. */
  document?: ProcessedFile | undefined;
  /** The user's message, so the reply threads under it. */
  replyToMessageId?: number | undefined;
  messageSeq: number;
  donePromise: Promise<void>;
}

/** Run the message, or tell the user why it could not run. */
export async function runRoutedTelegramMessage(params: RoutedTelegramRunParams): Promise<void> {
  const { userId, encryptedToken, telegramChatId, sessionId, messageSeq } = params;

  beginTelegramRun(userId, telegramChatId, params.donePromise);

  // Latest message wins: a newer message for this chat arrived while we waited
  // for the chat lock. The newer one is the one that gets processed.
  if (!isLatestMessage(userId, telegramChatId, messageSeq)) {
    console.warn(
      `Dropping superseded Telegram message (seq ${messageSeq}, chat ${telegramChatId})`,
    );
    return;
  }

  const chat = await prisma.chatSession.findFirst({
    where: { id: sessionId, userId },
    select: {
      id: true,
      title: true,
      modelProvider: true,
      modelName: true,
      thinkingLevel: true,
      toolConfig: true,
      projectId: true,
    },
  });
  if (!chat) {
    await sendTelegramMessage(
      encryptedToken,
      telegramChatId,
      "⚠️ That conversation no longer exists. Send /new to start one.",
    ).catch((err) => {
      console.error("Failed to report a missing chat to Telegram:", err);
    });
    return;
  }

  const model = await resolveChatModel(userId, chat);
  if (!model) {
    await sendTelegramMessage(
      encryptedToken,
      telegramChatId,
      "⚠️ No AI model configured. Please select a model in Settings → AI &amp; Models.",
      params.replyToMessageId != null ? { replyToMessageId: params.replyToMessageId } : undefined,
    ).catch((err) => {
      console.error("Failed to report a missing model to Telegram:", err);
    });
    return;
  }

  // Another run may already hold this chat: the browser, or a second phone
  // message that has not registered yet. Refuse instead of interleaving.
  if (await isChatBusy(userId, chat.id)) {
    await sendTelegramMessage(
      encryptedToken,
      telegramChatId,
      `⚠️ "${chat.title}" is busy. Try again in a moment.`,
      params.replyToMessageId != null ? { replyToMessageId: params.replyToMessageId } : undefined,
    ).catch((err) => {
      console.error("Failed to report a busy chat to Telegram:", err);
    });
    return;
  }

  const { entry } = await ensureChatAgent({
    userId,
    sessionId: chat.id,
    chatSession: chat,
    model,
  });

  if (entry.promptInFlight) {
    await sendTelegramMessage(
      encryptedToken,
      telegramChatId,
      `⚠️ "${chat.title}" is busy. Try again in a moment.`,
    ).catch((err) => {
      console.error("Failed to report a busy chat to Telegram:", err);
    });
    return;
  }
  entry.promptInFlight = true;

  // A phone user gets the same "working on it" signal as in the home thread.
  const stopTyping = startTypingIndicator(encryptedToken, telegramChatId);

  const renderer = createTelegramRunRenderer({
    userId,
    encryptedToken,
    telegramChatId,
    replyToMessageId: params.replyToMessageId,
    session: chat.id,
  });

  let session: AgentSession | undefined;
  let settled = false;
  try {
    const userMessage = await prisma.chatMessage.create({
      data: { sessionId: chat.id, role: "user", content: params.promptText },
    });
    await prisma.chatSession.update({
      where: { id: chat.id },
      data: { lastActivityAt: new Date(), messageCount: { increment: 1 } },
    });
    entry.lastPromptedMessageId = userMessage.id;

    if (params.document) {
      await recordTelegramDocumentAttachment({
        messageId: userMessage.id,
        file: params.document,
      }).catch((err) => {
        console.error(`Failed to record the Telegram document for chat ${chat.id}:`, err);
      });
    }

    session = entry.session;
    // Registered so a newer message (or `/stop`) can abort this run.
    attachTelegramSession(userId, telegramChatId, session);
    const unsubscribe = session.subscribe((event) => renderer.onEvent(event));

    try {
      await beginChatRun({ userId, sessionId: chat.id, session: entry.session });
    } catch (err) {
      unsubscribe();
      throw err;
    }

    settled = await dispatchChatRun({
      userId,
      sessionId: chat.id,
      entry,
      content: params.agentPrompt,
      images: params.imageData ? [params.imageData] : undefined,
    });
    unsubscribe();

    if (!settled) {
      // dispatchChatRun already released the claim and published the failure to
      // the web UI. the phone needs to hear it too.
      await sendTelegramMessage(
        encryptedToken,
        telegramChatId,
        "⚠️ Sorry, I encountered an error processing your message. Please try again.",
      ).catch((sendErr) => {
        console.error("Failed to report a failed Telegram run:", sendErr);
      });
      return;
    }

    await renderer.finish(false);
  } catch (err) {
    console.error(`Telegram run into chat ${chat.id} failed:`, err);
    await sendTelegramMessage(
      encryptedToken,
      telegramChatId,
      "⚠️ Sorry, I encountered an error processing your message. Please try again.",
    ).catch((sendErr) => {
      console.error("Failed to report a failed Telegram run:", sendErr);
    });
  } finally {
    stopTyping();
    // A failure before the agent was prompted still has to release the claim,
    // or the chat looks busy until the pool evicts it.
    if (!settled) {
      entry.promptInFlight = false;
      entry.lastPromptedMessageId = null;
    }
    if (session) unregisterTelegramSession(userId, telegramChatId, session);
  }
}

/** Whether the chat is generating, in this process or another one. */
async function isChatBusy(userId: string, sessionId: string): Promise<boolean> {
  const pooled = getPoolEntry(getPoolKey(userId, sessionId));
  if (pooled?.promptInFlight || pooled?.session.isStreaming === true) return true;
  return isSessionBusy(userId, sessionId);
}
