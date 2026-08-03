import fs from "fs/promises";
import path from "path";
import type { Bot, Context } from "grammy";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  createAgentSession,
  SessionManager,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "@earendil-works/pi-ai/compat";
import { prisma } from "@/lib/db";
import { createBot, sendTelegramMessage, startTypingIndicator } from "./client";
import { buildModelRuntime } from "@/lib/pi/models";
import { resolveTools } from "@/lib/pi/tool-registry";
import { resolveModelForPurpose } from "@/lib/pi/model-resolution";
import { DEFAULT_TOOL_CONFIG, type ToolConfig } from "@/lib/pi/tool-categories";
import { wrapWithApprovalGate, type ApprovalRequest } from "@/lib/pi/tool-approval-gate";
import { getDefaultPolicy } from "@/lib/pi/tool-infos";
import { resolveToolSummary } from "@/lib/pi/tool-summary-resolver";
import { sendTelegramApprovalRequest } from "./approval";
import { normalizeToolResult } from "@/lib/pi/message-replay";
import { extractCumulativeText, extractThinking } from "@/lib/pi/stream-logic";
import { saveAssistantMessage } from "@/lib/pi/stream-helpers";
import { saveCompactionMessage } from "@/lib/chat/compaction";
import { buildAgentSystemPrompt, lockSystemPrompt } from "@/lib/pi/processing-state";
import { registerActiveSession, unregisterActiveSession } from "@/lib/redis";
import { unregisterTelegramSession } from "./session-registry";

/** Allowed MIME types that can be passed as images to the vision model */
const IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/bmp",
  "image/tiff",
  "image/avif",
]);

/** Max file size for Telegram downloads (20MB per Telegram API limit) */
const MAX_TELEGRAM_FILE_BYTES = 20 * 1024 * 1024;

/** Uploads directory for storing downloaded Telegram files */
const UPLOADS_DIR = path.resolve(process.env.UPLOADS_DIR ?? "./uploads");

/**
 * File metadata extracted from a Telegram message (photo, document, etc.).
 */
export interface TelegramFileInfo {
  /** File ID from Telegram (used to download) */
  fileId: string;
  /** Original file name (may be undefined for photos) */
  fileName?: string | undefined;
  /** MIME type (may be undefined for photos) */
  mimeType?: string | undefined;
  /** File size in bytes */
  fileSize?: number | undefined;
  /** Width of the media */
  width?: number | undefined;
  /** Height of the media */
  height?: number | undefined;
}

/**
 * Result of downloading and processing a Telegram file.
 */
interface ProcessedFile {
  /** Base64-encoded image data (for image files) */
  imageData?: ImageContent;
  /** File path on disk (for document files) */
  filePath?: string;
  /** MIME type */
  mimeType: string;
  /** Original file name */
  fileName: string;
}

/**
 * Download a file from Telegram's CDN and process it.
 *
 * For image files: returns base64 data ready for the vision model.
 * For document files: saves to disk and returns the file path.
 */
async function downloadAndProcessTelegramFile(
  bot: Bot<Context>,
  userId: string,
  fileInfo: TelegramFileInfo,
): Promise<ProcessedFile> {
  // Get file info from Telegram API
  const file = await bot.api.getFile(fileInfo.fileId);

  // Download the file
  const downloadUrl = `https://api.telegram.org/file/bot${bot.token}/${file.file_path}`;
  const response = await fetch(downloadUrl);

  if (!response.ok) {
    throw new Error(`Failed to download Telegram file: ${response.status} ${response.statusText}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());

  if (buffer.length > MAX_TELEGRAM_FILE_BYTES) {
    throw new Error(`Telegram file too large: ${(buffer.length / 1024 / 1024).toFixed(1)}MB`);
  }

  const mimeType = fileInfo.mimeType ?? "application/octet-stream";
  const fileName = fileInfo.fileName ?? `telegram_${file.file_id}.dat`;

  // For image files, return as base64 for the vision model
  if (IMAGE_MIME_TYPES.has(mimeType)) {
    return {
      imageData: {
        type: "image",
        data: buffer.toString("base64"),
        mimeType,
      },
      mimeType,
      fileName,
    };
  }

  // For document files, save to disk
  const userDir = path.join(UPLOADS_DIR, userId, "telegram_files");
  await fs.mkdir(userDir, { recursive: true });

  // Sanitize file name and ensure unique path
  const safeName = path.basename(fileName.replace(/[^a-zA-Z0-9._-]/g, "_"));
  const filePath = path.join(userDir, safeName);
  await fs.writeFile(filePath, buffer);

  return { filePath, mimeType, fileName };
}

/**
 * Build a text description for a file attachment to include in the prompt.
 */
function buildFilePromptText(processedFile: ProcessedFile, caption: string | undefined): string {
  const parts: string[] = [];

  if (caption) {
    parts.push(caption);
  }

  if (processedFile.imageData) {
    parts.push(`[Image attached: ${processedFile.fileName} (${processedFile.mimeType})]`);
  } else if (processedFile.filePath) {
    parts.push(
      `[File attached: ${processedFile.fileName} (${processedFile.mimeType}) at ${processedFile.filePath}]`,
    );
  }

  return parts.join(" ");
}

/**
 * Shared Saale system prompt (matches the web chat stream endpoint).
 * Telegram-specific formatting guidance is appended below.
 */
const SAALE_SYSTEM_PROMPT = `You are Saale, a personal AI assistant built into a productivity workspace. You help with chat, email drafting, job management, calendar, and file organization.

Guidelines:
- Be concise and direct — get to the point without unnecessary preamble.
- Write naturally, like a capable colleague, not a generic AI.
- Use bullet points or short paragraphs when listing things.
- When uncertain, say so briefly rather than guessing.
- Match the user's tone and language preference.`;

/** Telegram-specific formatting addendum */
const TELEGRAM_FORMATTING_GUIDE = `

Telegram-specific guidelines:
- Keep messages readable at a glance — avoid long blocks of text.
- Use HTML formatting: <b>bold</b>, <i>italic</i>, <code>code</code>, <pre>preformatted</pre>.
- Avoid excessive formatting — keep it clean and readable on mobile.`;

/** Name of the auto-created Telegram agent definition */
const TELEGRAM_AGENT_NAME = "Telegram Assistant";

/**
 * Process an incoming Telegram message.
 *
 * Uses a file-based persistent Pi session so the agent has full conversation
 * history across messages — no manual context assembly needed.
 *
 * Supports text messages, photos, and document files. Images are passed
 * directly to the vision model; documents are saved to disk and referenced
 * in the prompt.
 */
export async function processTelegramMessage(
  params: {
    onSessionCreated?: (
      session: import("@earendil-works/pi-coding-agent").AgentSession,
      telegramChatId: bigint,
    ) => void;
    processingDone?: { resolve: () => void };
  } & {
    userId: string;
    encryptedToken: string;
    telegramChatId: bigint;
    telegramUserId: bigint;
    messageText: string;
    messageCaption?: string | undefined;
    fileInfo?: TelegramFileInfo | undefined;
    messageThreadId?: number | undefined;
    replyToMessageId?: number | undefined;
  },
): Promise<void> {
  const {
    userId,
    encryptedToken,
    telegramChatId,
    messageText,
    messageCaption,
    fileInfo,
    replyToMessageId,
    onSessionCreated,
    processingDone,
  } = params;

  // 1. Find or create the TelegramChat + ChatSession
  const { sessionId, telegramChatId: tgChatId } = await upsertTelegramChat(
    userId,
    encryptedToken,
    telegramChatId,
  );

  // 2. Download and process any attached file
  let processedFile: ProcessedFile | undefined;
  let promptText = messageText || messageCaption || "";

  if (fileInfo) {
    const telegramBot = createBot(encryptedToken);

    try {
      processedFile = await downloadAndProcessTelegramFile(telegramBot, userId, fileInfo);
    } catch (err) {
      console.error(`Failed to download Telegram file:`, err);
      // Continue without the file — the text/caption is still processed
    }
  }

  // Build final prompt text (caption + file description for media messages)
  if (processedFile) {
    const filePromptText = buildFilePromptText(processedFile, messageCaption);
    promptText = promptText ? `${promptText}\n${filePromptText}` : filePromptText;
  }

  // 3. Save the user message to the chat session (for WebUI visibility)
  await saveUserMessage(sessionId, promptText);

  // 4. Save attachment record only if a file was saved to disk.
  // Telegram images are base64-only (no file on disk) — their data is
  // already embedded in the message content, so no attachment record needed.
  // Telegram documents are saved to disk and need a record for cleanup.
  if (processedFile && processedFile.filePath) {
    const [userMessage] = await prisma.chatMessage.findMany({
      where: { sessionId, role: "user" },
      orderBy: { createdAt: "desc" },
      take: 1,
    });

    if (userMessage) {
      // Use a path relative to the user workspace so resolveImagePath()
      // and deleteAllImages() can locate it correctly
      const relativePath = `telegram_files/${path.basename(processedFile.filePath)}`;

      await prisma.chatAttachment.create({
        data: {
          messageId: userMessage.id,
          storageId: crypto.randomUUID(),
          fileName: processedFile.fileName,
          mimeType: processedFile.mimeType,
          size: 0,
          storagePath: relativePath,
        },
      });
    }
  }

  // 5. Register active session and start recurring typing indicator
  await registerActiveSession(userId, sessionId);
  const stopTyping = startTypingIndicator(encryptedToken, telegramChatId);

  // Track if this session was registered in the session registry (for interruption).
  // If so, we must unregister on completion.
  let wasRegistered = false;

  // 6. Ensure the Telegram agent definition exists
  const definition = await ensureTelegramAgentDefinition(userId);

  // 7. Build model runtime and resolve model (shared with web chat)
  const { modelRuntime } = await buildModelRuntime(userId);
  const explicitModelId = definition.modelId ?? null;
  const resolvedModelConfig = await resolveModelForPurpose(userId, "telegram", explicitModelId);
  if (!resolvedModelConfig) {
    await sendTelegramMessage(
      encryptedToken,
      telegramChatId,
      "⚠️ No AI model configured. Please select a model in Settings → AI &amp; Models.",
      replyToMessageId != null ? { replyToMessageId } : undefined,
    );
    return;
  }

  const modelId = explicitModelId ?? `${resolvedModelConfig.provider}:${resolvedModelConfig.name}`;
  const [provider, ...nameParts] = modelId.split(":");
  const resolvedModel = modelRuntime.getModel(provider ?? "", nameParts.join(":"));

  // 8. Create the AgentRun (for tracking in the dashboard)
  const run = await prisma.agentRun.create({
    data: {
      definitionId: definition.id,
      userId,
      status: "pending",
      prompt: promptText,
      systemPrompt: definition.systemPrompt,
      modelId,
      outputChannel: "telegram",
      outputChannelId: telegramChatId.toString(),
      telegramChatId: tgChatId,
    },
  });

  // 9. Create or resume the persistent Pi session
  const sessionDir = path.join(
    process.env.UPLOADS_DIR ?? "./uploads",
    "pi_sessions",
    userId,
    sessionId,
  );

  // Resolve tool config: user settings → agent definition overrides → defaults → no terminal
  const userSettings = await prisma.appSettings.findUnique({
    where: { userId },
    select: { defaultToolConfig: true, agentCustomInstructions: true, toolPolicies: true },
  });
  const userToolConfig = (userSettings?.defaultToolConfig as Record<string, boolean>) ?? {};
  const defToolConfig = (definition.toolConfig as Record<string, boolean>) ?? {};
  const resolvedToolConfig = {
    ...DEFAULT_TOOL_CONFIG,
    ...userToolConfig,
    ...defToolConfig,
    terminal: false,
  } as Required<ToolConfig>;

  // Build policy lookup from user settings (default: per-tool sane default)
  const toolPolicies = userSettings?.toolPolicies as Record<
    string,
    "off" | "ask" | "allow" | "auto"
  > | null;
  const getPolicy = async (toolName: string): Promise<"off" | "ask" | "allow" | "auto"> =>
    toolPolicies?.[toolName] ?? getDefaultPolicy(toolName);

  // Build the approval wrapper — every tool goes through the gate
  const approvalWrapper = (tool: ToolDefinition): ToolDefinition =>
    wrapWithApprovalGate(tool, userId, sessionId, getPolicy, (request: ApprovalRequest) => {
      sendTelegramApprovalRequest(userId, request).catch((err) => {
        console.error("Failed to send Telegram approval request:", err);
      });
    });

  const allCustomTools = await resolveTools(userId, run.id, resolvedToolConfig, {
    createTerminalScopedTools: () => {
      throw new Error("Terminal tools are not available for agent jobs.");
    },
    wrapWithApproval: approvalWrapper,
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
        "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max") ?? "off",
  });

  // Build system prompt using shared utility (aligned with web chat)
  const baseSystemPrompt = buildAgentSystemPrompt({
    customInstructions: userSettings?.agentCustomInstructions,
    toolConfig: resolvedToolConfig,
  });
  lockSystemPrompt(session, baseSystemPrompt + TELEGRAM_FORMATTING_GUIDE);

  // 10. Subscribe to session events — handle turn_end for intermediate messages
  //     and agent_end for final cleanup.
  //     This mirrors the regular chat stream endpoint's event handling.
  let turnIndex = 0;
  let currentTurnText = "";
  let currentTurnThinking = "";
  const currentTurnToolCallIds = new Set<string>();
  let rootMessageId: string | null = null;

  // Track which turns have already had their text flushed to Telegram
  // (happens in message_update when a tool call appears, so text arrives
  // before the approval request — not after at turn_end).
  const flushedTurnTexts = new Set<number>();

  // Track which tool calls have already had a summary sent to Telegram
  const sentToolSummaries = new Set<string>();

  /**
   * Flush accumulated text to Telegram immediately.
   *
   * Called from message_update when a tool call is detected so the agent's
   * response text arrives BEFORE the approval request (which fires inside
   * tool.execute(), before tool_execution_start).
   */
  function flushTurnText(turnIndex: number): void {
    if (!currentTurnText.trim()) return;
    if (flushedTurnTexts.has(turnIndex)) return;
    flushedTurnTexts.add(turnIndex);

    sendTelegramMessage(
      encryptedToken,
      telegramChatId,
      currentTurnText,
      turnIndex === 0 ? (replyToMessageId != null ? { replyToMessageId } : undefined) : undefined,
    ).catch((err) => {
      console.error("Failed to send Telegram message for turn:", err);
    });
  }

  // Track tool call results across turns
  const toolCallResults: Map<
    string,
    { name: string; args: Record<string, unknown>; result?: string; isError?: boolean }
  > = new Map();

  try {
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          unsubscribe();
          processingDone?.resolve();
          session.abort().catch((err) => {
            console.error(`Telegram session abort failed:`, err);
          });
          reject(new Error("Telegram agent timed out (10min)"));
        }, 10 * 60_000);

        const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
          switch (event.type) {
            case "message_update": {
              if (event.message.role !== "assistant") return;
              const msg = event.message as { content: unknown[] };
              currentTurnText = extractCumulativeText(msg.content);
              currentTurnThinking = extractThinking(msg.content) || "";

              // Track tool call IDs appearing in this message
              let hasToolCall = false;
              for (const content of msg.content) {
                if (
                  typeof content === "object" &&
                  content !== null &&
                  (content as Record<string, unknown>).type === "toolCall"
                ) {
                  currentTurnToolCallIds.add((content as Record<string, unknown>).id as string);
                  hasToolCall = true;
                }
              }

              // Flush text NOW when a tool call appears — the approval request
              // fires inside tool.execute() (before tool_execution_start), so we
              // need the agent's response text to arrive BEFORE the approval.
              if (hasToolCall) {
                flushTurnText(turnIndex);
              }
              break;
            }

            case "tool_execution_start": {
              toolCallResults.set(event.toolCallId, {
                name: event.toolName,
                args: event.args,
              });

              // Send a human-readable summary for tools that define one
              if (!sentToolSummaries.has(event.toolCallId)) {
                sentToolSummaries.add(event.toolCallId);

                resolveToolSummary(event.toolName, event.args)
                  .then((summary) => {
                    if (summary) {
                      sendTelegramMessage(
                        encryptedToken,
                        telegramChatId,
                        `🔧 <code>${summary}</code>`,
                      ).catch((err) => {
                        console.error("Failed to send Telegram tool summary:", err);
                      });
                    }
                  })
                  .catch((err) => {
                    console.error("Failed to resolve tool summary:", err);
                  });
              }
              break;
            }

            case "tool_execution_end": {
              const resultStr = normalizeToolResult(event.result);
              const existing = toolCallResults.get(event.toolCallId);
              if (existing) {
                existing.result = resultStr;
                existing.isError = event.isError;
              }
              break;
            }

            case "turn_end": {
              // Extract turn data from the assistant message
              const assistantMsg =
                event.message.role === "assistant"
                  ? (event.message as { content: unknown[] })
                  : null;

              const text = assistantMsg
                ? extractCumulativeText(assistantMsg.content)
                : currentTurnText;
              const thinking = assistantMsg
                ? extractThinking(assistantMsg.content)
                : currentTurnThinking || null;

              // Collect tool calls for this turn
              const toolCallBlocks = assistantMsg
                ? (assistantMsg.content.filter(
                    (c) =>
                      typeof c === "object" &&
                      c !== null &&
                      (c as Record<string, unknown>).type === "toolCall",
                  ) as Record<string, unknown>[])
                : [];
              const turnToolCalls = toolCallBlocks.map((tc) => {
                const result = toolCallResults.get(tc.id as string);
                return {
                  id: tc.id as string,
                  name: tc.name as string,
                  args: tc.arguments as unknown as Record<string, unknown>,
                  result: result?.result,
                  isError: result?.isError,
                };
              });

              // Send non-empty text to Telegram (skip if already flushed in message_update
              // when a tool call was detected — that ensures text arrives before approval).
              if (text.trim() && !flushedTurnTexts.has(turnIndex)) {
                sendTelegramMessage(
                  encryptedToken,
                  telegramChatId,
                  text,
                  turnIndex === 0
                    ? replyToMessageId != null
                      ? { replyToMessageId }
                      : undefined
                    : undefined,
                ).catch((err) => {
                  console.error("Failed to send Telegram message for turn:", err);
                });
              }

              // Save this turn to DB with full metadata (thinking, tool calls, parent link)
              saveAssistantMessage(
                sessionId,
                text,
                thinking || undefined,
                turnToolCalls.length > 0 ? turnToolCalls : undefined,
                rootMessageId,
              )
                .then((msg) => {
                  if (!rootMessageId) {
                    rootMessageId = msg.id;
                  }
                })
                .catch((err) => {
                  console.error("Failed to save turn message to DB:", err);
                });

              turnIndex++;
              currentTurnText = "";
              currentTurnThinking = "";
              currentTurnToolCallIds.clear();
              break;
            }

            case "compaction_start": {
              sendTelegramMessage(
                encryptedToken,
                telegramChatId,
                "\U0001f504 Compacting conversation...",
              ).catch((err) => {
                console.error("Failed to send Telegram compaction start message:", err);
              });
              break;
            }

            case "compaction_end": {
              if (event.result && !event.aborted) {
                // Save compaction to DB (for web UI visibility)
                saveCompactionMessage({
                  sessionId,
                  summary: event.result.summary,
                  tokensBefore: event.result.tokensBefore,
                });

                // Report token stats to Telegram (no summary)
                const tokensAfter = event.result.estimatedTokensAfter;
                const tokensInfo = tokensAfter
                  ? ` (was ${event.result.tokensBefore.toLocaleString()} tokens, now ~${tokensAfter.toLocaleString()})`
                  : ` (was ${event.result.tokensBefore.toLocaleString()} tokens)`;
                sendTelegramMessage(
                  encryptedToken,
                  telegramChatId,
                  `\u2705 Compaction complete${tokensInfo}.`,
                ).catch((err) => {
                  console.error("Failed to send Telegram compaction end message:", err);
                });
              }
              break;
            }

            case "agent_end": {
              clearTimeout(timer);
              unsubscribe();
              processingDone?.resolve();
              resolve();
              break;
            }

            case "auto_retry_end": {
              if (!event.success) {
                clearTimeout(timer);
                unsubscribe();
                processingDone?.resolve();
                reject(new Error(event.finalError ?? "Agent retry failed"));
              }
              break;
            }
          }
        });

        // Notify caller about the created session (for registry tracking)
        if (onSessionCreated) {
          onSessionCreated(session, telegramChatId);
          wasRegistered = true;
        }

        // Send the user message to the agent (with images if available)
        const images = processedFile?.imageData ? [processedFile.imageData] : undefined;
        session.agent.prompt(promptText, images).catch((err) => {
          clearTimeout(timer);
          unsubscribe();
          processingDone?.resolve();
          reject(err);
        });
      });
    } finally {
      stopTyping();
    }

    // For single-turn responses (no turn_end fired), save the final message
    if (turnIndex === 0 && currentTurnText.trim()) {
      await sendTelegramMessage(
        encryptedToken,
        telegramChatId,
        currentTurnText,
        replyToMessageId != null ? { replyToMessageId } : undefined,
      );

      await saveAssistantMessage(sessionId, currentTurnText, currentTurnThinking || undefined);
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
    const incrementCount = turnIndex > 0 ? turnIndex : 1;
    await Promise.all([
      unregisterActiveSession(userId, sessionId),
      prisma.chatSession.update({
        where: { id: sessionId },
        data: { messageCount: { increment: incrementCount } },
      }),
    ]);

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
  } finally {
    // Always unregister from the session registry (for interruption tracking)
    if (wasRegistered) {
      unregisterTelegramSession(userId, telegramChatId);
    }
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
        systemPrompt: SAALE_SYSTEM_PROMPT + TELEGRAM_FORMATTING_GUIDE,
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

/**
 * Compact a Telegram chat session.
 *
 * Recreates the Pi session from persistent JSONL files, runs compaction,
 * and sends the result back to Telegram.
 */
export async function compactTelegramSession(params: {
  userId: string;
  encryptedToken: string;
  telegramChatId: bigint;
  replyToMessageId?: number | undefined;
}): Promise<void> {
  const { userId, encryptedToken, telegramChatId, replyToMessageId } = params;

  // 1. Find the chat session linked to this Telegram chat
  const account = await prisma.telegramAccount.findUnique({
    where: { userId },
  });
  if (!account) {
    await sendTelegramMessage(
      encryptedToken,
      telegramChatId,
      "⚠️ Telegram integration not configured.",
      replyToMessageId != null ? { replyToMessageId } : undefined,
    );
    return;
  }

  const tgChat = await prisma.telegramChat.findUnique({
    where: {
      telegramAccountId_telegramChatId: {
        telegramAccountId: account.id,
        telegramChatId,
      },
    },
  });
  if (!tgChat) {
    await sendTelegramMessage(
      encryptedToken,
      telegramChatId,
      "⚠️ No active chat session found. Send a message first.",
      replyToMessageId != null ? { replyToMessageId } : undefined,
    );
    return;
  }

  const sessionId = tgChat.sessionId;

  // 2. Get model config from the agent definition or user settings
  const definition = await prisma.agentDefinition.findFirst({
    where: { userId, name: TELEGRAM_AGENT_NAME },
  });

  const { modelRuntime } = await buildModelRuntime(userId);
  const explicitModelId = definition?.modelId ?? null;
  const resolvedModelConfig = await resolveModelForPurpose(userId, "telegram", explicitModelId);
  if (!resolvedModelConfig) {
    await sendTelegramMessage(
      encryptedToken,
      telegramChatId,
      "⚠️ No AI model configured. Please select a model in Settings → AI &amp; Models.",
      replyToMessageId != null ? { replyToMessageId } : undefined,
    );
    return;
  }

  const modelId = explicitModelId ?? `${resolvedModelConfig.provider}:${resolvedModelConfig.name}`;
  const [provider, ...nameParts] = modelId.split(":");
  const resolvedModel = modelRuntime.getModel(provider ?? "", nameParts.join(":"));

  // 3. Build tool config
  const userSettings = await prisma.appSettings.findUnique({
    where: { userId },
    select: { defaultToolConfig: true, agentCustomInstructions: true },
  });
  const userToolConfig = (userSettings?.defaultToolConfig as Record<string, boolean>) ?? {};
  const defToolConfig = (definition?.toolConfig as Record<string, boolean>) ?? {};
  const resolvedToolConfig = {
    ...DEFAULT_TOOL_CONFIG,
    ...userToolConfig,
    ...defToolConfig,
    terminal: false,
  } as Required<ToolConfig>;

  // 4. Create persistent session from JSONL files
  const sessionDir = path.join(
    process.env.UPLOADS_DIR ?? "./uploads",
    "pi_sessions",
    userId,
    sessionId,
  );

  const allCustomTools = await resolveTools(userId, "compact", resolvedToolConfig, {
    createTerminalScopedTools: () => {
      throw new Error("Terminal tools are not available for agent jobs.");
    },
  });

  const { session } = await createAgentSession({
    sessionManager: SessionManager.continueRecent(sessionDir, sessionDir),
    modelRuntime,
    noTools: "builtin",
    ...(resolvedModel ? { model: resolvedModel } : {}),
    customTools: allCustomTools,
    thinkingLevel: (definition?.thinkingLevel as "off") ?? "off",
  });

  // Build system prompt
  const baseSystemPrompt = buildAgentSystemPrompt({
    customInstructions: userSettings?.agentCustomInstructions,
    toolConfig: resolvedToolConfig,
  });
  lockSystemPrompt(session, baseSystemPrompt + TELEGRAM_FORMATTING_GUIDE);

  try {
    const result = await session.compact();

    if (result?.summary) {
      await saveCompactionMessage({
        sessionId,
        summary: result.summary,
        tokensBefore: result.tokensBefore,
      });
    }

    const tokensInfo = result?.tokensBefore
      ? ` (was ${result.tokensBefore.toLocaleString()} tokens)`
      : "";
    await sendTelegramMessage(
      encryptedToken,
      telegramChatId,
      `✅ Conversation compacted${tokensInfo}.`,
      replyToMessageId != null ? { replyToMessageId } : undefined,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    if (message === "Already compacted") {
      await sendTelegramMessage(
        encryptedToken,
        telegramChatId,
        "ℹ️ This conversation is already compacted.",
        replyToMessageId != null ? { replyToMessageId } : undefined,
      );
    } else if (message === "Nothing to compact (session too small)") {
      await sendTelegramMessage(
        encryptedToken,
        telegramChatId,
        "ℹ️ The conversation is too short to compact.",
        replyToMessageId != null ? { replyToMessageId } : undefined,
      );
    } else {
      console.error("Telegram compaction failed:", err);
      await sendTelegramMessage(
        encryptedToken,
        telegramChatId,
        "⚠️ Compaction failed. Please try again.",
        replyToMessageId != null ? { replyToMessageId } : undefined,
      );
    }
  } finally {
    session.dispose();
  }
}

// ─── Chat Session Helpers ────────────────────────────────────────────────────

/** Telegram chats expire after this many ms of inactivity (6 hours) */
const TELEGRAM_CHAT_EXPIRY_MS = 6 * 60 * 60 * 1000;

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
    // Use the latest message's createdAt to determine activity — this is more
    // reliable than ChatSession.updatedAt which is only set when the session
    // record itself is modified (at the end of processing). If processing
    // errors before that update, updatedAt stays stale and the chat appears
    // "active" when it isn't.
    const [lastMessage] = await prisma.chatMessage.findMany({
      where: { sessionId: tgChat.sessionId },
      orderBy: { createdAt: "desc" },
      take: 1,
    });
    needsNewSession =
      lastMessage == null || lastMessage.createdAt.getTime() + TELEGRAM_CHAT_EXPIRY_MS < Date.now();
  }

  if (needsNewSession) {
    const sessionId = crypto.randomUUID();

    await prisma.$transaction(async (tx) => {
      await tx.chatSession.create({
        data: {
          id: sessionId,
          userId,
          title: "Telegram Chat",
          temporary: false,
        },
      });

      tgChat = await tx.telegramChat.upsert({
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
