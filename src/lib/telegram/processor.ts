import path from "path";
import {
  createAgentSession,
  SessionManager,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { prisma } from "@/lib/db";
import { createBot, sendTelegramMessage, startTypingIndicator } from "./client";
import { buildModelRuntime } from "@/lib/pi/models";
import { resolveTools } from "@/lib/pi/tool-registry";
import { resolveModelForPurpose } from "@/lib/pi/model-resolution";
import { thinkingLevelOption } from "@/lib/pi/thinking-levels";
import { DEFAULT_TOOL_CONFIG, type ToolConfig } from "@/lib/pi/tool-categories";
import {
  createToolApprovalGate,
  type ApprovalRequest,
  type ApprovalResolutionData,
} from "@/lib/pi/tool-approval-gate";
import { resolveToolSummary } from "@/lib/pi/tool-summary-resolver";
import { sendTelegramApprovalRequest, deleteTelegramApprovalMessage } from "./approval";
import { createApprovalCardTracker } from "./approval-cards";
import { extractCumulativeText } from "@/lib/pi/stream-logic";
import { extractProviderError, type ProviderErrorSource } from "@/lib/pi/provider-error";
import { saveCompactionMessage } from "@/lib/chat/compaction";
import { buildAgentSystemPrompt, createSystemPromptLoader } from "@/lib/pi/processing-state";
import { withChatLock } from "./chat-lock";
import { createSessionSettings } from "@/lib/pi/settings";
import { createTerminalScopedTools } from "@/lib/pi/session";
import {
  downloadAndProcessTelegramFile,
  buildFilePromptText,
  TELEGRAM_FILES_DIR,
  type ProcessedFile,
  type TelegramFileInfo,
} from "./files";
import { registerActiveSession, markGenerationStart } from "@/lib/redis";
import { resetSessionEvents, subscribeSessionEvents } from "@/lib/pi/session-events";
import { createSessionEventTracker } from "@/lib/pi/session-event-tracker";
import { createAgentIdleTimeout } from "@/lib/pi/agent-idle-timeout";
import { unregisterTelegramSession, wasTelegramSessionInterrupted } from "./session-registry";
import { TELEGRAM_AGENT_NAME } from "@/lib/agent-jobs/system-managed";

/**
 * Idle timeout for Telegram agent runs. If the session produces no events
 * at all (tokens, tool calls, turns) for this long, the run is considered
 * stalled and aborted. Any agent activity resets the window, so this is
 * NOT a cap on total run duration.
 */
const AGENT_IDLE_TIMEOUT_MS = 10 * 60_000;

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

/**
 * Process an incoming Telegram message.
 *
 * Uses a file-based persistent Pi session so the agent has full conversation
 * history across messages — no manual context assembly needed.
 *
 * Supports text messages, photos, and document files. Images are passed
 * directly to the vision model; documents are uploaded into the terminal
 * workspace (or saved locally as a fallback) and referenced in the prompt.
 */
export async function processTelegramMessage(params: ProcessTelegramMessageParams): Promise<void> {
  // One run per chat: two overlapping runs share a transcript directory and can
  // both create the chat's session (see `withChatLock`). Interruptions still
  // replace a live run — the webhook aborts it before calling in.
  return withChatLock(`${params.userId}:${params.telegramChatId}`, () =>
    runTelegramMessage(params),
  );
}

interface ProcessTelegramMessageParams {
  onSessionCreated?: (
    session: import("@earendil-works/pi-coding-agent").AgentSession,
    telegramChatId: bigint,
  ) => void;
  processingDone?: { resolve: () => void };
  userId: string;
  encryptedToken: string;
  telegramChatId: bigint;
  telegramUserId: bigint;
  messageText: string;
  messageCaption?: string | undefined;
  fileInfo?: TelegramFileInfo | undefined;
  messageThreadId?: number | undefined;
  replyToMessageId?: number | undefined;
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
      // Use a path relative to the user workspace (the terminal home when
      // Open Terminal is configured) so the workspace-files endpoint and
      // cleanup helpers can locate it correctly
      const relativePath = path.join(TELEGRAM_FILES_DIR, path.basename(processedFile.filePath!));

      await prisma.chatAttachment.create({
        data: {
          messageId: userMessage.id,
          storageId: crypto.randomUUID(),
          fileName: processedFile.fileName,
          mimeType: processedFile.mimeType,
          size: processedFile.size ?? 0,
          storagePath: relativePath,
        },
      });
    }
  }

  // 5. Register active session and start recurring typing indicator.
  //    Also record when the generation started (used to detect stale
  //    generations) and clear the session event buffer so no stale events
  //    from previous runs are replayed to web observers.
  await registerActiveSession(userId, sessionId);
  await markGenerationStart(sessionId);
  await resetSessionEvents(sessionId);
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

  // Resolve tool config: user settings → agent definition overrides → defaults
  // (the system definition enables terminal access so files sent via
  // Telegram are reachable by the agent's file tools)
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
  } as Required<ToolConfig>;

  // Build policy lookup from user settings (default: per-tool sane default)
  const toolPolicies = userSettings?.toolPolicies as Record<
    string,
    "off" | "ask" | "allow" | "auto"
  > | null;

  // Track approval cards sent to Telegram so they can be deleted when the
  // approval resolves (button, web, timeout, interrupt) or the run ends.
  const cardTracker = createApprovalCardTracker((cardId) =>
    deleteTelegramApprovalMessage(encryptedToken, cardId),
  );

  // Every resolution path publishes `tool_approval_resolved` on the session
  // bus — resolving the card from that event covers Telegram button
  // presses, web-UI decisions, approval timeouts, and interrupts.
  const approvalBusSub = subscribeSessionEvents(sessionId, (evt) => {
    if (evt.event !== "tool_approval_resolved") return;
    const data = evt.data as ApprovalResolutionData | undefined;
    if (data?.toolCallId) {
      cardTracker.onResolved(data.toolCallId);
    }
  }).catch((err) => {
    console.error("Failed to subscribe to approval resolution events:", err);
    return undefined;
  });

  // Build the approval wrapper — every tool goes through the gate
  const approvalWrapper = createToolApprovalGate({
    userId,
    sessionId,
    toolPolicies,
    emitApprovalRequest: (request: ApprovalRequest) => {
      sendTelegramApprovalRequest(userId, request)
        .then((cardId) => {
          if (cardId) {
            cardTracker.track(request.toolCallId, cardId);
          }
        })
        .catch((err) => {
          console.error("Failed to send Telegram approval request:", err);
        });
    },
  });

  const allCustomTools = await resolveTools(userId, run.id, resolvedToolConfig, {
    createTerminalScopedTools,
    wrapWithApproval: approvalWrapper,
  });

  const sessionManager = SessionManager.continueRecent(sessionDir, sessionDir);

  // Build system prompt using shared utility (aligned with web chat)
  const baseSystemPrompt = buildAgentSystemPrompt({
    customInstructions: userSettings?.agentCustomInstructions,
    toolConfig: resolvedToolConfig,
  });

  const { session } = await createAgentSession({
    sessionManager,
    modelRuntime,
    settingsManager: createSessionSettings(),
    noTools: "builtin",
    ...(resolvedModel ? { model: resolvedModel } : {}),
    customTools: allCustomTools,
    resourceLoader: await createSystemPromptLoader(
      baseSystemPrompt + TELEGRAM_FORMATTING_GUIDE,
      sessionDir,
    ),
    ...thinkingLevelOption(definition.thinkingLevel),
  });

  // Mark the run as running — startedAt is when the agent actually starts
  // (the run record was created earlier as "pending").
  await prisma.agentRun.update({
    where: { id: run.id },
    data: { status: "running", startedAt: new Date() },
  });

  // 10. Wire the shared session event tracker — it persists assistant
  //     messages to the DB and publishes live stream events (turn_start,
  //     token, thinking, tool_start/end, turn_end, message_saved, done) on
  //     the session event bus so web observers see this generation live.
  const tracker = createSessionEventTracker({
    sessionId,
    userId,
    session,
  });

  // Telegram-specific send state. DB persistence + stream events are handled
  // by the tracker above — this subscription only sends messages to Telegram.
  let turnIndex = 0;
  let currentTurnText = "";

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

  try {
    try {
      await new Promise<void>((resolve, reject) => {
        // Idle timeout — fires only if the session goes completely silent
        // (hung model, stuck tool). Every agent event resets the window, so
        // an actively working agent can run longer than the idle window.
        const idleTimeout = createAgentIdleTimeout({
          session,
          timeoutMs: AGENT_IDLE_TIMEOUT_MS,
          label: `telegram:${run.id}`,
          onTimeout: () => {
            unsubscribe();
            processingDone?.resolve();
            session.abort().catch((err) => {
              console.error(`Telegram session abort failed:`, err);
            });
            reject(new Error("Telegram agent stalled (no activity for 10min)"));
          },
        });

        // The provider failure of the last attempt, if it ended in one. Only
        // the settled event decides the run's outcome (see the agent_end case).
        let lastProviderError: string | null = null;

        const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
          switch (event.type) {
            case "message_update": {
              if (event.message.role !== "assistant") return;
              const msg = event.message as { content: unknown[] };
              currentTurnText = extractCumulativeText(msg.content);

              // Flush text NOW when a tool call appears — the approval request
              // fires inside tool.execute() (before tool_execution_start), so we
              // need the agent's response text to arrive BEFORE the approval.
              const hasToolCall = msg.content.some(
                (c) =>
                  typeof c === "object" &&
                  c !== null &&
                  (c as Record<string, unknown>).type === "toolCall",
              );
              if (hasToolCall) {
                flushTurnText(turnIndex);
              }
              break;
            }

            case "tool_execution_start": {
              // Send a human-readable summary for tools that define one
              if (!sentToolSummaries.has(event.toolCallId)) {
                sentToolSummaries.add(event.toolCallId);

                resolveToolSummary(event.toolName, event.args)
                  .then((summary) => {
                    if (summary) {
                      sendTelegramMessage(
                        encryptedToken,
                        telegramChatId,
                        `🔧 \`${summary}\``,
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
              // Results are tracked by the session event tracker for DB saves.
              break;
            }

            case "turn_end": {
              const assistantMsg =
                event.message.role === "assistant"
                  ? (event.message as { content: unknown[] })
                  : null;

              const text = assistantMsg
                ? extractCumulativeText(assistantMsg.content)
                : currentTurnText;

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

              turnIndex++;
              currentTurnText = "";
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
              // Compaction summary is persisted by the session event tracker.
              if (event.result && !event.aborted) {
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

            // agent_end only means the current run iteration stopped — the
            // SDK may still retry, auto-compact, or continue the run. The
            // settled event is the "completely finished" signal (TUI parity),
            // and the only safe place to decide the run's outcome: an overflow
            // failure reports `willRetry: false` (compaction handles it, not
            // retry) and is followed by a compact-and-continue, so deciding
            // here would report an error for a run whose answer arrives a
            // moment later — and drop it, because the listener is gone.
            case "agent_settled": {
              idleTimeout.clear();
              unsubscribe();
              processingDone?.resolve();
              if (lastProviderError) {
                reject(new Error(lastProviderError));
              } else {
                resolve();
              }
              break;
            }

            // A provider failure does not throw — it ends the assistant
            // message with stopReason "error". Record it per attempt; the
            // settled handler decides. `willRetry` runs are skipped because
            // their failure is provisional and the retry reports its own.
            case "agent_end": {
              if (event.willRetry) break;
              const lastAssistant = [...event.messages]
                .reverse()
                .find((m) => m.role === "assistant") as ProviderErrorSource | undefined;
              lastProviderError = extractProviderError(lastAssistant);
              break;
            }

            case "auto_retry_end": {
              if (!event.success) {
                lastProviderError = event.finalError ?? "Agent retry failed";
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

        // Send the user message to the agent (with images if available).
        // session.prompt() — the TUI path — runs the SDK's pre-prompt
        // compaction check and post-run processing (retry, auto-compaction,
        // overflow continue) and resolves when the session settles. The
        // system prompt comes from the resource loader above, so the
        // SDK's per-turn prompt resolution keeps it.
        const promptOptions = processedFile?.imageData
          ? { images: [processedFile.imageData] }
          : undefined;
        session.prompt(promptText, promptOptions).catch((err) => {
          idleTimeout.clear();
          unsubscribe();
          processingDone?.resolve();
          reject(err);
        });
      });
    } finally {
      stopTyping();
    }

    // Detect interruption BEFORE cleanup: a new message aborting this run
    // marks it in the registry (the old entry may already have been
    // overwritten — in that narrow race the run counts as completed).
    const interrupted = wasTelegramSessionInterrupted(session);

    // For single-turn responses (no turn_end fired), make sure the text is
    // still delivered to Telegram. The tracker handles the DB save.
    // Interrupted runs are superseded by the new message's response —
    // a stale partial reply would only confuse the user.
    if (!interrupted && turnIndex === 0 && currentTurnText.trim() && !flushedTurnTexts.has(0)) {
      await sendTelegramMessage(
        encryptedToken,
        telegramChatId,
        currentTurnText,
        replyToMessageId != null ? { replyToMessageId } : undefined,
      );
    }

    // Get stats and mark run as completed (or cancelled if interrupted)
    const stats = session.getSessionStats();
    await prisma.agentRun.update({
      where: { id: run.id },
      data: {
        status: interrupted ? "cancelled" : "completed",
        ...(interrupted ? { error: "Interrupted by user message" } : {}),
        inputTokens: stats.tokens.input,
        outputTokens: stats.tokens.output,
        cost: stats.cost,
        completedAt: new Date(),
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
    // The tracker unsubscribes itself on agent_settled; dispose() is a no-op then.
    // It also unregisters the active session + updates the message count.
    tracker.dispose();

    // Delete any approval cards still outstanding (a denial that raced with
    // the run ending, or a bus event that was missed).
    cardTracker.flush();

    // Await the bus subscription settling so a late subscription can't
    // leak its listener after the run is done.
    await approvalBusSub.then((unsub) => {
      if (unsub) {
        unsub();
      }
    });

    // Always unregister from the session registry (for interruption
    // tracking). Identity-checked: a new run registered during the
    // interrupt must not be unregistered by the old run's cleanup.
    if (wasRegistered) {
      unregisterTelegramSession(userId, telegramChatId, session);
    }
  }
}

/**
 * Ensure the Telegram agent definition exists for the user.
 * Creates it on first Telegram interaction if it doesn't exist.
 */
export async function ensureTelegramAgentDefinition(userId: string): Promise<{
  id: string;
  systemPrompt: string | null;
  toolConfig: unknown;
  modelId: string | null;
  thinkingLevel: string;
}> {
  let definition = await prisma.agentDefinition.findFirst({
    where: { userId, name: TELEGRAM_AGENT_NAME },
  });

  if (definition && !definition.systemManaged) {
    // Adopt pre-existing definitions (created before the systemManaged flag
    // existed) so the runtime lock applies to them too.
    definition = await prisma.agentDefinition.update({
      where: { id: definition.id },
      data: { systemManaged: true },
    });
  }

  if (definition) {
    // Ensure the definition always grants terminal access: the Telegram agent
    // needs file tools to reach documents sent via Telegram (they are
    // uploaded into the Open Terminal workspace).
    const existingToolConfig = (definition.toolConfig as Record<string, boolean> | null) ?? {};
    if (existingToolConfig.terminal !== true) {
      definition = await prisma.agentDefinition.update({
        where: { id: definition.id },
        data: { toolConfig: { ...existingToolConfig, terminal: true } },
      });
    }
  }

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
          terminal: true,
        },
        modelId: null,
        thinkingLevel: "off",
        enabled: true,
        systemManaged: true,
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
export async function compactTelegramSession(params: CompactTelegramSessionParams): Promise<void> {
  // Shares the chat's lock with generation: compacting the transcript while a
  // run is still writing to it would summarise a partial conversation, and the
  // summary could end up off the active path.
  return withChatLock(`${params.userId}:${params.telegramChatId}`, () =>
    runTelegramCompaction(params),
  );
}

interface CompactTelegramSessionParams {
  userId: string;
  encryptedToken: string;
  telegramChatId: bigint;
  replyToMessageId?: number | undefined;
}

/** The body of `compactTelegramSession`, run exclusively per chat. */
async function runTelegramCompaction(params: CompactTelegramSessionParams): Promise<void> {
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
  } as Required<ToolConfig>;

  // 4. Create persistent session from JSONL files
  const sessionDir = path.join(
    process.env.UPLOADS_DIR ?? "./uploads",
    "pi_sessions",
    userId,
    sessionId,
  );

  const allCustomTools = await resolveTools(userId, "compact", resolvedToolConfig, {
    createTerminalScopedTools,
  });

  // Build system prompt
  const baseSystemPrompt = buildAgentSystemPrompt({
    customInstructions: userSettings?.agentCustomInstructions,
    toolConfig: resolvedToolConfig,
  });

  const { session } = await createAgentSession({
    sessionManager: SessionManager.continueRecent(sessionDir, sessionDir),
    modelRuntime,
    settingsManager: createSessionSettings(),
    noTools: "builtin",
    ...(resolvedModel ? { model: resolvedModel } : {}),
    customTools: allCustomTools,
    resourceLoader: await createSystemPromptLoader(
      baseSystemPrompt + TELEGRAM_FORMATTING_GUIDE,
      sessionDir,
    ),
    ...thinkingLevelOption(definition?.thinkingLevel),
  });

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

  // Real chat activity — advance lastActivityAt so the session list sorts/
  // displays this chat correctly (updatedAt alone is unreliable here: the
  // tracker only writes the session when the run settles, so a processing
  // error would leave it stale).
  await prisma.chatSession
    .update({
      where: { id: sessionId },
      data: { lastActivityAt: new Date() },
    })
    .catch((err) => {
      console.error(`Failed to bump lastActivityAt for telegram session ${sessionId}:`, err);
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
