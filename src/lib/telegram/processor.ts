import path from "path";
import {
  createAgentSession,
  SessionManager,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { prisma } from "@/lib/db";
import { sendTelegramMessage, sendTypingIndicator } from "./client";
import { buildModelRuntime } from "@/lib/pi/models";
import { resolveTools } from "@/lib/pi/tool-registry";
import { DEFAULT_TOOL_CONFIG, type ToolConfig } from "@/lib/pi/tool-categories";

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

/**
 * Process an incoming Telegram message.
 *
 * Uses a file-based persistent Pi session so the agent has full conversation
 * history across messages — no manual context assembly needed.
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

  const modelId = definition.modelId ?? `${model.provider}:${model.name}`;

  // 6. Create the AgentRun (for tracking in the dashboard)
  const run = await prisma.agentRun.create({
    data: {
      definitionId: definition.id,
      userId,
      status: "pending",
      prompt: messageText,
      systemPrompt: definition.systemPrompt,
      modelId,
      outputChannel: "telegram",
      outputChannelId: telegramChatId.toString(),
      telegramChatId: tgChatId,
    },
  });

  // 7. Create or resume the persistent Pi session
  const sessionDir = path.join(
    process.env.UPLOADS_DIR ?? "./uploads",
    "pi_sessions",
    userId,
    sessionId,
  );

  const { modelRuntime } = await buildModelRuntime(userId);
  const [provider, ...nameParts] = modelId.split(":");
  const resolvedModel = modelRuntime.getModel(provider ?? "", nameParts.join(":"));

  const rawToolConfig = (definition.toolConfig as Record<string, boolean>) ?? {};
  const resolvedToolConfig = {
    ...DEFAULT_TOOL_CONFIG,
    ...rawToolConfig,
    terminal: false,
  } as Required<ToolConfig>;

  const allCustomTools = await resolveTools(userId, run.id, resolvedToolConfig, {
    createTerminalScopedTools: () => {
      throw new Error("Terminal tools are not available for agent jobs.");
    },
  });

  const sessionManager = SessionManager.continueRecent(sessionDir, sessionDir);

  const { session } = await createAgentSession({
    sessionManager,
    modelRuntime,
    noTools: "builtin",
    ...(resolvedModel ? { model: resolvedModel } : {}),
    customTools: allCustomTools,
    thinkingLevel:
      (definition.thinkingLevel as
        | "off"
        | "minimal"
        | "low"
        | "medium"
        | "high"
        | "xhigh"
        | "max") ?? "off",
  });

  session.agent.state.systemPrompt = definition.systemPrompt ?? TELEGRAM_SYSTEM_PROMPT;

  // 8. Subscribe to session events and send response via Telegram
  let assistantText = "";

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe();
        session.abort().catch((err) => {
          console.error(`Telegram session abort failed:`, err);
        });
        reject(new Error("Telegram agent timed out (10min)"));
      }, 10 * 60_000);

      const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
        switch (event.type) {
          case "message_update": {
            if (event.message.role !== "assistant") return;
            const content = (event.message as { content: unknown[] }).content;
            const textBlocks = content.filter(
              (c): c is { type: string; text: string } =>
                typeof c === "object" &&
                c !== null &&
                "type" in c &&
                (c as Record<string, unknown>).type === "text",
            );
            assistantText = textBlocks.map((c) => (c.text as string) || "").join("");
            break;
          }

          case "agent_end": {
            clearTimeout(timer);
            unsubscribe();
            resolve();
            break;
          }

          case "auto_retry_end": {
            if (!event.success) {
              clearTimeout(timer);
              unsubscribe();
              reject(new Error(event.finalError ?? "Agent retry failed"));
            }
            break;
          }
        }
      });

      // Send the user message to the agent
      session.agent.prompt(messageText).catch((err) => {
        clearTimeout(timer);
        unsubscribe();
        reject(err);
      });
    });

    // Send the assistant response to Telegram
    if (assistantText.trim()) {
      await sendTelegramMessage(
        encryptedToken,
        telegramChatId,
        assistantText,
        replyToMessageId != null ? { replyToMessageId } : undefined,
      );

      // Save to ChatSession for WebUI visibility
      await prisma.chatMessage.create({
        data: { sessionId, role: "assistant", content: assistantText },
      });
    }

    // Get stats and mark run as completed
    const stats = session.getSessionStats();
    await prisma.agentRun.update({
      where: { id: run.id },
      data: {
        status: "completed",
        inputTokens: stats.tokens.input,
        outputTokens: stats.tokens.output,
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
        prompt: "",
        systemPrompt: TELEGRAM_SYSTEM_PROMPT,
        toolConfig: {
          email: true,
          calendar: true,
          chatSearch: true,
          web: true,
          memory: true,
          tasks: true,
        },
        modelId: null,
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
