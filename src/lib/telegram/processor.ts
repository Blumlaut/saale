import { prisma } from "@/lib/db";
import { sendTelegramMessage, sendTypingIndicator } from "./client";
import { executeAgentRun } from "@/lib/agent-jobs/executor";
import type { AgentOutput } from "@/lib/agent-jobs/executor";

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

/** Name of the auto-created Telegram agent definition */
const TELEGRAM_AGENT_NAME = "Telegram Assistant";

/** How many prior messages to load as context for each Telegram run */
const CONTEXT_MESSAGE_COUNT = 20;

/**
 * Process an incoming Telegram message.
 * Creates an AgentRun and executes it with Telegram as the output channel.
 */
export async function processTelegramMessage(params: {
  userId: string;
  encryptedToken: string;
  telegramChatId: bigint;
  telegramUserId: bigint;
  messageText: string;
  messageThreadId?: number;
  replyToMessageId?: number;
}): Promise<void> {
  const { userId, encryptedToken, telegramChatId, messageText, replyToMessageId } = params;

  // 1. Find or create the TelegramChat + ChatSession
  const { sessionId, telegramChatId: tgChatId } = await upsertTelegramChat(
    userId,
    encryptedToken,
    telegramChatId,
  );

  // 2. Save the user message to the chat session (for WebUI visibility)
  await saveUserMessage(sessionId, messageText);

  // 3. Send typing indicator
  sendTypingIndicator(encryptedToken, telegramChatId);

  // 4. Ensure the Telegram agent definition exists
  const definition = await ensureTelegramAgentDefinition(userId);

  // 5. Resolve model
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

  // 6. Load context from prior agent runs
  const contextMessages = await loadRunContext(userId, telegramChatId);

  // 7. Build the effective prompt (context + current message)
  const effectivePrompt = buildPrompt(contextMessages, messageText);

  // 8. Create the AgentRun
  const run = await prisma.agentRun.create({
    data: {
      definitionId: definition.id,
      userId,
      status: "pending",
      prompt: effectivePrompt,
      systemPrompt: definition.systemPrompt,
      modelId: definition.modelId ?? `${model.provider}:${model.name}`,
      outputChannel: "telegram",
      outputChannelId: telegramChatId.toString(),
      telegramChatId: tgChatId,
    },
  });

  // 10. Build Telegram output handler
  const telegramOutput: AgentOutput = {
    send: async (content: string) => {
      if (content.trim()) {
        // Send to Telegram
        await sendTelegramMessage(
          encryptedToken,
          telegramChatId,
          content,
          replyToMessageId != null ? { replyToMessageId } : undefined,
        );
        // Also save to ChatSession for WebUI visibility
        await prisma.chatMessage.create({
          data: { sessionId, role: "assistant", content },
        });
      }
    },
    typing: () => {
      sendTypingIndicator(encryptedToken, telegramChatId).catch((err) => {
        console.error("Failed to send typing indicator:", err);
      });
    },
  };

  // 11. Execute the agent run
  try {
    const stats = await executeAgentRun(
      run.id,
      {
        prompt: effectivePrompt,
        systemPrompt: definition.systemPrompt,
        toolConfig: definition.toolConfig as Record<string, boolean> | null,
        modelId: definition.modelId ?? `${model.provider}:${model.name}`,
        thinkingLevel: definition.thinkingLevel,
      },
      userId,
      telegramOutput,
    );

    // Mark run as completed
    await prisma.agentRun.update({
      where: { id: run.id },
      data: {
        status: "completed",
        inputTokens: stats.inputTokens,
        outputTokens: stats.outputTokens,
        cost: stats.cost,
        startedAt: new Date(),
        completedAt: new Date(),
      },
    });

    // Update chat session metadata
    await prisma.chatSession.update({
      where: { id: sessionId },
      data: {
        messageCount: { increment: 1 },
        processingSince: null,
      },
    });

    // Update definition lastRunAt
    await prisma.agentDefinition.update({
      where: { id: definition.id },
      data: { lastRunAt: new Date() },
    });
  } catch (err) {
    console.error(`Telegram agent run ${run.id} failed:`, err);

    await prisma.agentRun.update({
      where: { id: run.id },
      data: {
        status: "error",
        error: (err as Error).message,
        startedAt: new Date(),
        completedAt: new Date(),
      },
    });

    await sendTelegramMessage(
      encryptedToken,
      telegramChatId,
      "⚠️ Sorry, I encountered an error processing your message. Please try again.",
      replyToMessageId != null ? { replyToMessageId } : undefined,
    );
  }
}

/**
 * Ensure the Telegram agent definition exists for the user.
 * Creates it on first Telegram interaction if it doesn't exist.
 */
async function ensureTelegramAgentDefinition(userId: string): Promise<{
  id: string;
  systemPrompt: string | null;
  toolConfig: unknown;
  modelId: string | null;
  thinkingLevel: string;
}> {
  let definition = await prisma.agentDefinition.findFirst({
    where: { userId, name: TELEGRAM_AGENT_NAME },
  });

  if (!definition) {
    definition = await prisma.agentDefinition.create({
      data: {
        userId,
        name: TELEGRAM_AGENT_NAME,
        description: "Auto-created agent for Telegram conversations",
        prompt: "", // Will be set per-run with user message
        systemPrompt: TELEGRAM_SYSTEM_PROMPT,
        toolConfig: {
          email: true,
          calendar: true,
          chatSearch: true,
          web: true,
          memory: true,
          tasks: true,
        },
        modelId: null, // Uses user default
        thinkingLevel: "off",
        enabled: true,
      },
    });
  }

  return {
    id: definition.id,
    systemPrompt: definition.systemPrompt,
    toolConfig: definition.toolConfig,
    modelId: definition.modelId,
    thinkingLevel: definition.thinkingLevel,
  };
}

/**
 * Load context messages from prior agent runs for this Telegram chat.
 */
async function loadRunContext(
  userId: string,
  telegramChatId: bigint,
): Promise<Array<{ role: string; content: string }>> {
  const runs = await prisma.agentRun.findMany({
    where: { userId, telegramChatId },
    orderBy: { createdAt: "desc" },
    take: Math.ceil(CONTEXT_MESSAGE_COUNT / 2), // Roughly 2 messages per run
    select: {
      id: true,
      prompt: true,
    },
  });

  const messages: Array<{ role: string; content: string }> = [];

  // Load messages from runs in reverse chronological order
  for (const run of runs) {
    const runMessages = await prisma.agentRunMessage.findMany({
      where: { runId: run.id },
      orderBy: { createdAt: "desc" },
      select: { role: true, content: true },
    });

    for (const msg of runMessages) {
      messages.unshift({ role: msg.role, content: msg.content });
    }

    if (messages.length >= CONTEXT_MESSAGE_COUNT) {
      break;
    }
  }

  return messages.slice(-CONTEXT_MESSAGE_COUNT);
}

/**
 * Build the effective prompt from context and current message.
 */
function buildPrompt(
  context: Array<{ role: string; content: string }>,
  currentMessage: string,
): string {
  if (context.length === 0) {
    return currentMessage;
  }

  const contextLines = context.map((m) => {
    const role = m.role === "user" ? "User" : "Assistant";
    return `${role}: ${m.content}`;
  });

  return `Conversation context (most recent first):\n${contextLines.join("\n")}\n\n---\n\nUser: ${currentMessage}`;
}

// ─── Chat Session Helpers ────────────────────────────────────────────────────

/** Telegram chats expire after this many ms of inactivity (12 hours) */
const TELEGRAM_CHAT_EXPIRY_MS = 12 * 60 * 60 * 1000;

/**
 * Find or create the TelegramChat record and its linked ChatSession.
 */
async function upsertTelegramChat(
  userId: string,
  _encryptedToken: string,
  telegramChatId: bigint,
): Promise<{ sessionId: string; telegramChatId: bigint }> {
  const account = await prisma.telegramAccount.findUnique({
    where: { userId },
  });
  if (!account) {
    throw new Error("Telegram account not found");
  }

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

  return { sessionId: tgChat!.sessionId, telegramChatId: tgChat!.telegramChatId };
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

// ─── Model Resolution ────────────────────────────────────────────────────────

/**
 * Resolve the default model for a user.
 */
async function resolveUserModel(
  userId: string,
): Promise<{ provider: string; name: string } | null> {
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

// ─── Whitelist Helpers ───────────────────────────────────────────────────────

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
