import { prisma } from "@/lib/db";
import { sendTelegramMessage, sendTypingIndicator } from "./client";
import { createPersistentSession } from "@/lib/pi/persistent-session";
import { DEFAULT_TOOL_CONFIG, type ToolConfig } from "@/lib/pi/tool-categories";
import path from "path";

/** Uploads directory for session storage */
const UPLOADS_DIR = path.resolve(process.env.UPLOADS_DIR ?? "./uploads");

/**
 * Get the session directory for a Telegram chat's Pi session files.
 */
function getSessionDir(userId: string, sessionId: string): string {
  return path.join(UPLOADS_DIR, "pi_sessions", userId, "telegram", sessionId);
}

/**
 * Default system prompt for Telegram-based interactions.
 */
const TELEGRAM_SYSTEM_PROMPT = `You are Saale, a personal AI assistant accessible via Telegram. You help with questions, tasks, email drafting, calendar, and general productivity.

Guidelines:
- Be concise and direct — Telegram messages should be readable at a glance.
- Use HTML formatting: <b>bold</b>, <i>italic</i>, <code>code</code>, <pre>preformatted</pre>.
- Avoid excessive formatting — keep it clean and readable on mobile.
- When uncertain, say so briefly rather than guessing.
- Match the user's tone and language preference.`;

/**
 * Process an incoming Telegram message.
 * This is the core flow: validate → create/find chat → send to AI → reply.
 */
export async function processTelegramMessage(params: {
  userId: string;
  encryptedToken: string;
  telegramChatId: bigint;
  telegramUserId: bigint;
  messageText: string;
  messageThreadId?: number; // for forum topics
  replyToMessageId?: number;
}): Promise<void> {
  const { userId, encryptedToken, telegramChatId, messageText, replyToMessageId } = params;

  // 1. Find or create the TelegramChat + ChatSession
  const { sessionId } = await upsertTelegramChat(userId, encryptedToken, telegramChatId);

  // 2. Save the user message to the chat session
  await saveUserMessage(sessionId, messageText);

  // 3. Send typing indicator
  sendTypingIndicator(encryptedToken, telegramChatId);

  // 4. Resolve model for the user
  const model = await resolveUserModel(userId);
  if (!model) {
    await sendTelegramMessage(
      encryptedToken,
      telegramChatId,
      "⚠️ No AI model configured. Please select a model in Settings → AI &amp; Models.",
      replyToMessageId != null ? { replyToMessageId } : undefined,
    );
    return;
  }

  // 5. Resolve tool config from user settings
  const settings = await prisma.appSettings.findUnique({
    where: { userId },
    select: { defaultToolConfig: true },
  });
  const toolConfig = (settings?.defaultToolConfig ?? DEFAULT_TOOL_CONFIG) as ToolConfig;

  // 6. Create or resume Pi session and process the message
  try {
    const sessionDir = getSessionDir(userId, sessionId);
    const { session } = await createPersistentSession({
      userId,
      sessionId,
      sessionDir,
      customTools: [],
      toolConfig,
      modelProvider: model.provider,
      modelName: model.name,
      thinkingLevel: "off",
    });

    // Build system prompt with tool awareness
    const terminalInstruction =
      toolConfig.terminal === true
        ? "\n\nA Terminal is available to run commands and read/write files. Common utilities such as bash, wget, curl, python, yt-dlp.. are available."
        : "";
    const memoryInstruction =
      toolConfig.memory !== false
        ? "\n\nYou have a persistent memory system. If the user references something you don't know about, use `memory_search` to look it up before answering."
        : "";

    session.agent.state.systemPrompt =
      TELEGRAM_SYSTEM_PROMPT + terminalInstruction + memoryInstruction;

    // Collect the full response
    let fullResponse = "";
    let resolved = false;

    const unsubscribe = session.subscribe((event) => {
      if (event.type === "message_update" && event.message.role === "assistant") {
        const msg = event.message as { content: unknown[] };
        const textBlocks = msg.content.filter(
          (c) =>
            typeof c === "object" && c !== null && (c as Record<string, unknown>).type === "text",
        );
        fullResponse = textBlocks
          .map((c) => ((c as Record<string, unknown>).text as string) || "")
          .join("");
      }
      if (event.type === "agent_end") {
        resolved = true;
      }
    });

    // Prompt the agent and wait for completion
    await session.agent.prompt(messageText);

    // Wait for agent_end (with timeout)
    await Promise.race([
      new Promise<void>((resolve) => {
        const check = setInterval(() => {
          if (resolved) {
            clearInterval(check);
            resolve();
          }
        }, 50);
      }),
      new Promise<void>((resolve) => setTimeout(resolve, 60_000)), // 60s timeout
    ]);

    unsubscribe();

    // Save assistant response to DB
    await saveAssistantMessage(sessionId, fullResponse);

    // Update chat session metadata
    await prisma.chatSession.update({
      where: { id: sessionId },
      data: {
        messageCount: { increment: 1 },
        processingSince: null,
      },
    });

    // Send response back to Telegram
    if (fullResponse.trim()) {
      await sendTelegramMessage(
        encryptedToken,
        telegramChatId,
        fullResponse,
        replyToMessageId != null ? { replyToMessageId } : undefined,
      );
    }
  } catch (err) {
    console.error("Telegram message processing failed:", err);
    await sendTelegramMessage(
      encryptedToken,
      telegramChatId,
      "⚠️ Sorry, I encountered an error processing your message. Please try again.",
      replyToMessageId != null ? { replyToMessageId } : undefined,
    );
  }
}

/** Telegram chats expire after this many ms of inactivity (12 hours) */
const TELEGRAM_CHAT_EXPIRY_MS = 12 * 60 * 60 * 1000;

/**
 * Find or create the TelegramChat record and its linked ChatSession.
 * Creates a new session if:
 * - No TelegramChat exists yet
 * - The linked ChatSession was deleted
 * - The session has been inactive for 12+ hours
 */
async function upsertTelegramChat(
  userId: string,
  _encryptedToken: string,
  telegramChatId: bigint,
): Promise<{ sessionId: string }> {
  // Find the user's Telegram account (user isolation via userId)
  const account = await prisma.telegramAccount.findUnique({
    where: { userId },
  });
  if (!account) {
    throw new Error("Telegram account not found");
  }

  // Find existing TelegramChat
  let tgChat = await prisma.telegramChat.findUnique({
    where: {
      telegramAccountId_telegramChatId: {
        telegramAccountId: account.id,
        telegramChatId,
      },
    },
  });

  let needsNewSession = !tgChat;

  if (tgChat) {
    const session = await prisma.chatSession.findUnique({ where: { id: tgChat.sessionId } });
    // Session was deleted or expired (12h inactivity)
    needsNewSession =
      session == null || session.updatedAt.getTime() + TELEGRAM_CHAT_EXPIRY_MS < Date.now();
  }

  if (needsNewSession) {
    const sessionId = crypto.randomUUID();

    await prisma.chatSession.create({
      data: {
        id: sessionId,
        userId,
        title: "Telegram Chat",
        temporary: false,
      },
    });

    tgChat = await prisma.telegramChat.upsert({
      where: {
        telegramAccountId_telegramChatId: {
          telegramAccountId: account.id,
          telegramChatId,
        },
      },
      create: {
        telegramAccountId: account.id,
        telegramChatId,
        chatType: "private",
        sessionId,
      },
      update: {
        sessionId,
      },
    });
  }

  // tgChat is non-null here: if it was null, needsNewSession would be true and upsert would have run
  return { sessionId: tgChat!.sessionId };
}

/**
 * Save a user message to the chat session.
 */
async function saveUserMessage(sessionId: string, content: string): Promise<void> {
  await prisma.chatMessage.create({
    data: {
      sessionId,
      role: "user",
      content,
    },
  });
}

/**
 * Save an assistant message to the chat session.
 */
async function saveAssistantMessage(sessionId: string, content: string): Promise<void> {
  await prisma.chatMessage.create({
    data: {
      sessionId,
      role: "assistant",
      content,
    },
  });
}

/**
 * Resolve the default model for a user.
 * Checks user settings first, then admin defaults.
 */
async function resolveUserModel(
  userId: string,
): Promise<{ provider: string; name: string } | null> {
  // Check user settings
  const settings = await prisma.appSettings.findUnique({
    where: { userId },
    select: { defaultModelProvider: true, defaultModelName: true },
  });

  if (
    settings?.defaultModelProvider &&
    settings.defaultModelProvider.trim() &&
    settings?.defaultModelName &&
    settings.defaultModelName.trim()
  ) {
    return {
      provider: settings.defaultModelProvider.trim(),
      name: settings.defaultModelName.trim(),
    };
  }

  // Check admin defaults
  const adminSettings = await prisma.adminSettings.findFirst({
    select: { globalModelProvider: true, globalModelName: true },
  });

  if (
    adminSettings?.globalModelProvider &&
    adminSettings.globalModelProvider.trim() &&
    adminSettings?.globalModelName &&
    adminSettings.globalModelName.trim()
  ) {
    return {
      provider: adminSettings.globalModelProvider.trim(),
      name: adminSettings.globalModelName.trim(),
    };
  }

  return null;
}

/**
 * Check if a Telegram user is whitelisted for a given account.
 */
export async function isWhitelisted(
  telegramAccountId: string,
  telegramUserId: bigint,
): Promise<boolean> {
  const entry = await prisma.telegramWhitelist.findUnique({
    where: {
      telegramAccountId_telegramUserId: {
        telegramAccountId,
        telegramUserId,
      },
    },
  });
  return !!entry;
}

/**
 * Upsert a whitelist entry (called when user info changes).
 */
export async function upsertWhitelistDisplayName(
  telegramAccountId: string,
  telegramUserId: bigint,
  displayName: string | null,
): Promise<void> {
  await prisma.telegramWhitelist.upsert({
    where: {
      telegramAccountId_telegramUserId: {
        telegramAccountId,
        telegramUserId,
      },
    },
    update: {
      displayName: displayName ?? null,
    },
    create: {
      telegramAccountId,
      telegramUserId,
      displayName: displayName ?? null,
    },
  });
}
