import path from "path";
import { SessionManager, type AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { prisma } from "@/lib/db";
import { getUploadsDir } from "@/lib/uploads";
import { createBot, sendTelegramMessage, startTypingIndicator } from "./client";
import { buildModelRuntime } from "@/lib/pi/models";
import { resolveTools } from "@/lib/pi/tool-registry";
import { resolveModelForPurpose } from "@/lib/pi/model-resolution";
import { thinkingLevelOption } from "@/lib/pi/thinking-levels";
import { DEFAULT_TOOL_CONFIG, type ToolConfig } from "@/lib/pi/tool-categories";
import { normalizeToolExposure } from "@/lib/pi/tool-exposure";
import {
  createToolApprovalGate,
  type ApprovalRequest,
  type ApprovalResolutionData,
} from "@/lib/pi/tool-approval-gate";
import { sendTelegramApprovalRequest, deleteTelegramApprovalMessage } from "./approval";
import { createApprovalCardTracker } from "./approval-cards";
import { extractProviderError, type ProviderErrorSource } from "@/lib/pi/provider-error";
import { saveCompactionMessage } from "@/lib/chat/compaction";
import { compactChatSession, compactionOutcome } from "@/lib/chat/compact-chat";
import { listSandboxEnvNames } from "@/lib/sandbox/env";
import {
  buildAgentSystemPrompt,
  createAgentResourceLoader,
  createSystemPromptLoader,
  startSessionExtensions,
} from "@/lib/pi/processing-state";
import { withChatLock } from "./chat-lock";
import { createSaaleAgentSession } from "@/lib/pi/agent-session";
import { createSandboxScopedTools } from "@/lib/pi/session";
import {
  downloadAndProcessTelegramFile,
  buildFilePromptText,
  recordTelegramDocumentAttachment,
  type ProcessedFile,
  type TelegramFileInfo,
} from "./files";
import { createTelegramRunRenderer } from "./render";
import { resolveTelegramTarget } from "./routing";
import { runRoutedTelegramMessage } from "./routed-run";
import { registerActiveSession } from "@/lib/redis";
import { resetSessionEvents, subscribeSessionEvents } from "@/lib/pi/session-events";
import { createSessionEventTracker } from "@/lib/pi/session-event-tracker";
import { createAgentIdleTimeout } from "@/lib/pi/agent-idle-timeout";
import { buildQuotedContext, type QuotedMessageContext } from "./reply-context";
import { getLinkByUserId } from "./links";
import {
  beginTelegramRun,
  clearTelegramRun,
  isLatestMessage,
  unregisterTelegramSession,
  wasTelegramSessionInterrupted,
} from "./session-registry";
import { TELEGRAM_AGENT_NAME } from "@/lib/agent-jobs/system-managed";
import type { CommandOutcome } from "@/lib/commands/types";
import { TELEGRAM_FORMATTING_GUIDE, SAALE_SYSTEM_PROMPT } from "./prompt";

/**
 * Idle timeout for Telegram agent runs. If the session produces no events
 * at all (tokens, tool calls, turns) for this long, the run is considered
 * stalled and aborted. Any agent activity resets the window, so this is
 * NOT a cap on total run duration.
 */
const AGENT_IDLE_TIMEOUT_MS = 10 * 60_000;

/**
 * Process an incoming Telegram message.
 *
 * Uses a file-based persistent Pi session so the agent has full conversation
 * history across messages. no manual context assembly needed.
 *
 * Supports text messages, photos, and document files. Images are passed
 * directly to the vision model; documents are uploaded into the terminal
 * workspace (or saved locally as a fallback) and referenced in the prompt.
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
  onSessionCreated?: (
    session: import("@earendil-works/pi-coding-agent").AgentSession,
    telegramChatId: bigint,
  ) => void;
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
    onSessionCreated,
    messageSeq,
    donePromise,
  } = params;

  // Register this run as the chat's active run BEFORE the slow setup below
  // (DB upsert, model resolution, session creation take seconds). an
  // incoming message must be able to supersede the run even while the Pi
  // session does not exist yet.
  beginTelegramRun(userId, telegramChatId, donePromise ?? new Promise<void>(() => {}));

  // Latest message wins: a newer message for this chat arrived while we were
  // waiting for the chat lock. Drop this run before doing any work. the
  // newer message is the one that gets processed (and replied to).
  if (!isLatestMessage(userId, telegramChatId, messageSeq)) {
    console.warn(
      `Dropping superseded Telegram message (seq ${messageSeq}, msg ${replyToMessageId}, chat ${telegramChatId})`,
    );
    // Remove our entry. nothing left to interrupt (the superseding message
    // overwrites the entry when its run starts).
    clearTelegramRun(userId, telegramChatId);
    return;
  }

  // 1. Which chat does this message continue? A reply goes back to the chat
  //    that sent the message it answers, otherwise to the chat that spoke last.
  //    The link's home thread is the fallback, and the only path that builds
  //    its own Pi session here.
  const target = await resolveTelegramTarget({
    userId,
    telegramChatId,
    replyToMessageId: replyToQuoted ? BigInt(replyToQuoted.messageId) : null,
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

  // A message that continues an existing chat runs on that chat's own pooled
  // agent, the same one the web UI prompts, so both surfaces share one
  // transcript and one set of settings.
  if (target.via !== "home") {
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
    return;
  }

  const sessionId = target.sessionId;

  // 3. Save the user message to the chat session (for WebUI visibility)
  await saveUserMessage(sessionId, promptText);

  // 4. Save attachment record only if a file was saved to disk.
  // Telegram images are base64-only (no file on disk). their data is
  // already embedded in the message content, so no attachment record needed.
  // Telegram documents are saved to disk and need a record for cleanup.
  if (processedFile?.filePath) {
    const [userMessage] = await prisma.chatMessage.findMany({
      where: { sessionId, role: "user" },
      orderBy: { createdAt: "desc" },
      take: 1,
    });

    if (userMessage) {
      await recordTelegramDocumentAttachment({
        messageId: userMessage.id,
        file: processedFile,
      });
    }
  }

  // 5. Register active session and start recurring typing indicator.
  //    Also clear the session event buffer so no stale events from previous
  //    runs are replayed to web observers.
  await registerActiveSession(userId, sessionId);
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
      prompt: agentPrompt,
      systemPrompt: definition.systemPrompt,
      modelId,
      outputChannel: "telegram",
      outputChannelId: telegramChatId.toString(),
      telegramChatId,
    },
  });

  // 9. Create or resume the persistent Pi session
  const sessionDir = path.join(getUploadsDir(), "pi_sessions", userId, sessionId);

  // Resolve tool config: user settings → agent definition overrides → defaults
  // (the system definition enables terminal access so files sent via
  // Telegram are reachable by the agent's file tools)
  const userSettings = await prisma.appSettings.findUnique({
    where: { userId },
    select: {
      defaultToolConfig: true,
      agentCustomInstructions: true,
      toolPolicies: true,
      toolExposure: true,
    },
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
  // bus. resolving the card from that event covers Telegram button
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

  // Approval channel. a card in the Telegram chat. Shared by the tool wrapper
  // and the MCP tool gate.
  const emitApprovalRequest = (request: ApprovalRequest) => {
    sendTelegramApprovalRequest(userId, request)
      .then((cardId) => {
        if (cardId) {
          cardTracker.track(request.toolCallId, cardId);
        }
      })
      .catch((err) => {
        console.error("Failed to send Telegram approval request:", err);
      });
  };

  // Build the approval wrapper. every tool goes through the gate
  const approvalWrapper = createToolApprovalGate({
    userId,
    sessionId,
    toolPolicies,
    emitApprovalRequest,
  });

  const allCustomTools = await resolveTools(userId, sessionId, resolvedToolConfig, {
    createSandboxScopedTools,
    wrapWithApproval: approvalWrapper,
    exposure: normalizeToolExposure(userSettings?.toolExposure),
  });

  const sessionManager = SessionManager.continueRecent(sessionDir, sessionDir);

  // Build system prompt using shared utility (aligned with web chat)
  const baseSystemPrompt = buildAgentSystemPrompt({
    customInstructions: userSettings?.agentCustomInstructions,
    toolConfig: resolvedToolConfig,
    sandboxEnvNames: await listSandboxEnvNames(userId),
  });

  const { session } = await createSaaleAgentSession(userId, {
    sessionManager,
    modelRuntime,
    noTools: "builtin",
    ...(resolvedModel ? { model: resolvedModel } : {}),
    customTools: allCustomTools,
    resourceLoader: await createAgentResourceLoader({
      prompt: baseSystemPrompt + TELEGRAM_FORMATTING_GUIDE,
      cwd: sessionDir,
      interactive: { userId, sessionId, toolPolicies, emitApprovalRequest },
    }),
    ...thinkingLevelOption(definition.thinkingLevel),
  });

  await startSessionExtensions(session);

  // Mark the run as running. startedAt is when the agent actually starts
  // (the run record was created earlier as "pending").
  await prisma.agentRun.update({
    where: { id: run.id },
    data: { status: "running", startedAt: new Date() },
  });

  // 10. Wire the shared session event tracker. it persists assistant
  //     messages to the DB and publishes live stream events (turn_start,
  //     token, thinking, tool_start/end, turn_end, message_saved, done) on
  //     the session event bus so web observers see this generation live.
  const tracker = createSessionEventTracker({
    sessionId,
    userId,
    session,
  });

  // Everything the phone shows comes from the shared renderer. DB persistence
  // and stream events are handled by the tracker above.
  const renderer = createTelegramRunRenderer({
    userId,
    encryptedToken,
    telegramChatId,
    ...(replyToMessageId != null ? { replyToMessageId } : {}),
  });

  // Checkpoint. a newer message may have arrived during the slow setup
  // above, before the Pi session existed (so the webhook's interrupt could
  // not abort it). Latest message wins: dispose the session, skip the prompt,
  // and treat the run as interrupted (cancelled, no reply).
  const superseded = !isLatestMessage(userId, telegramChatId, messageSeq);
  if (superseded) {
    console.warn(`Telegram run ${run.id} superseded before prompt (seq ${messageSeq}). skipping`);
    stopTyping();
    session.dispose();
  }

  try {
    if (!superseded) {
      try {
        await new Promise<void>((resolve, reject) => {
          // Idle timeout. fires only if the session goes completely silent
          // (hung model, stuck tool). Every agent event resets the window, so
          // an actively working agent can run longer than the idle window.
          const idleTimeout = createAgentIdleTimeout({
            session,
            timeoutMs: AGENT_IDLE_TIMEOUT_MS,
            label: `telegram:${run.id}`,
            onTimeout: () => {
              unsubscribe();
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
            // Rendering (text, tool summaries, shared files, compaction
            // notices) belongs to the renderer. the switch decides how the run
            // ends.
            renderer.onEvent(event);

            switch (event.type) {
              // agent_end only means the current run iteration stopped. the
              // SDK may still retry, auto-compact, or continue the run. The
              // settled event is the "completely finished" signal (TUI parity),
              // and the only safe place to decide the run's outcome: an overflow
              // failure reports `willRetry: false` (compaction handles it, not
              // retry) and is followed by a compact-and-continue, so deciding
              // here would report an error for a run whose answer arrives a
              // moment later. and drop it, because the listener is gone.
              case "agent_settled": {
                idleTimeout.clear();
                unsubscribe();
                if (lastProviderError) {
                  reject(new Error(lastProviderError));
                } else {
                  resolve();
                }
                break;
              }

              // A provider failure does not throw. it ends the assistant
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
          // session.prompt(). the TUI path. runs the SDK's pre-prompt
          // compaction check and post-run processing (retry, auto-compaction,
          // overflow continue) and resolves when the session settles. The
          // system prompt comes from the resource loader above, so the
          // SDK's per-turn prompt resolution keeps it.
          const promptOptions = processedFile?.imageData
            ? { images: [processedFile.imageData] }
            : undefined;
          session.prompt(agentPrompt, promptOptions).catch((err) => {
            idleTimeout.clear();
            unsubscribe();
            reject(err);
          });
        });
      } finally {
        stopTyping();
      }
    }

    // Detect interruption BEFORE cleanup: a new message aborting this run
    // marks it in the registry (the old entry may already have been
    // overwritten. in that narrow race the run counts as completed).
    // `superseded` covers the checkpoint path, where the run bailed before
    // the session was attached to the registry entry.
    const interrupted = superseded || wasTelegramSessionInterrupted(session);

    // A single-turn response never fires turn_end. the renderer delivers its
    // text. Interrupted runs stay silent.
    await renderer.finish(interrupted);

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
    // interrupt must not be unregistered by the old run's cleanup. A
    // superseded run (bailed at its checkpoint) has no session attached,
    // so it clears its own entry outright.
    if (superseded) {
      clearTelegramRun(userId, telegramChatId);
    } else if (wasRegistered) {
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
    //
    // `agentJobs` is granted for the same "always" reason: a user talking to
    // the bot is the most likely place to ask for something to happen later
    // ("remind me at 9"). Without it the request can only be refused. the
    // chat has no way to schedule anything, and the web UI is a trip away.
    const existingToolConfig = (definition.toolConfig as Record<string, boolean> | null) ?? {};
    if (existingToolConfig.terminal !== true || existingToolConfig.agentJobs !== true) {
      definition = await prisma.agentDefinition.update({
        where: { id: definition.id },
        data: {
          toolConfig: { ...existingToolConfig, terminal: true, agentJobs: true },
        },
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
          telegram: true,
          agentJobs: true,
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
 * Compact the chat a Telegram command was sent in.
 *
 * The home thread keeps its own path. it is not a pooled chat, so it is rebuilt
 * from its JSONL files. A message routed into an existing chat compacts that
 * chat through the same helper the web uses.
 *
 * The caller (the `/compact` command handler) renders the outcome. nothing is
 * sent to Telegram from here, so the web and Telegram paths can share one
 * command definition.
 */
export async function compactTelegramSession(
  params: CompactTelegramSessionParams,
): Promise<CommandOutcome> {
  const link = await getLinkByUserId(params.userId);
  if (!link) {
    return { message: "Telegram is not linked to this account.", tone: "error" };
  }

  const sessionId = params.sessionId ?? link.sessionId;
  if (!sessionId) {
    return { message: "No active chat session found. Send a message first.", tone: "error" };
  }

  if (sessionId !== link.sessionId) {
    return compactionOutcome(await compactChatSession({ userId: params.userId, sessionId }));
  }

  // Shares the chat's lock with generation: compacting the transcript while a
  // run is still writing to it would summarise a partial conversation, and the
  // summary could end up off the active path.
  return withChatLock(`${params.userId}:${params.telegramChatId}`, () =>
    runTelegramCompaction({ ...params, sessionId }),
  );
}

interface CompactTelegramSessionParams {
  userId: string;
  telegramChatId: bigint;
  /** The chat the command was sent in, as routed. */
  sessionId?: string | null | undefined;
}

/** The body of `compactTelegramSession`, run exclusively per chat. */
async function runTelegramCompaction(
  params: CompactTelegramSessionParams & { sessionId: string },
): Promise<CommandOutcome> {
  const { userId, sessionId } = params;

  // 2. Get model config from the agent definition or user settings
  const definition = await prisma.agentDefinition.findFirst({
    where: { userId, name: TELEGRAM_AGENT_NAME },
  });

  const { modelRuntime } = await buildModelRuntime(userId);
  const explicitModelId = definition?.modelId ?? null;
  const resolvedModelConfig = await resolveModelForPurpose(userId, "telegram", explicitModelId);
  if (!resolvedModelConfig) {
    return {
      message: "No AI model configured. Please select a model in Settings → AI & Models.",
      tone: "error",
    };
  }

  const modelId = explicitModelId ?? `${resolvedModelConfig.provider}:${resolvedModelConfig.name}`;
  const [provider, ...nameParts] = modelId.split(":");
  const resolvedModel = modelRuntime.getModel(provider ?? "", nameParts.join(":"));

  // 3. Build tool config
  const userSettings = await prisma.appSettings.findUnique({
    where: { userId },
    select: { defaultToolConfig: true, agentCustomInstructions: true, toolExposure: true },
  });
  const userToolConfig = (userSettings?.defaultToolConfig as Record<string, boolean>) ?? {};
  const defToolConfig = (definition?.toolConfig as Record<string, boolean>) ?? {};
  const resolvedToolConfig = {
    ...DEFAULT_TOOL_CONFIG,
    ...userToolConfig,
    ...defToolConfig,
  } as Required<ToolConfig>;

  // 4. Create persistent session from JSONL files
  const sessionDir = path.join(getUploadsDir(), "pi_sessions", userId, sessionId);

  const allCustomTools = await resolveTools(userId, "compact", resolvedToolConfig, {
    createSandboxScopedTools,
    exposure: normalizeToolExposure(userSettings?.toolExposure),
  });

  // Build system prompt
  const baseSystemPrompt = buildAgentSystemPrompt({
    customInstructions: userSettings?.agentCustomInstructions,
    toolConfig: resolvedToolConfig,
    sandboxEnvNames: await listSandboxEnvNames(userId),
  });

  const { session } = await createSaaleAgentSession(userId, {
    sessionManager: SessionManager.continueRecent(sessionDir, sessionDir),
    modelRuntime,
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
    return { message: `Conversation compacted${tokensInfo}.`, tone: "success" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    if (message === "Already compacted") {
      return { message: "This conversation is already compacted.", tone: "info" };
    }
    if (message === "Nothing to compact (session too small)") {
      return { message: "The conversation is too short to compact.", tone: "info" };
    }

    console.error("Telegram compaction failed:", err);
    return { message: "Compaction failed. Please try again.", tone: "error" };
  } finally {
    session.dispose();
  }
}

// ─── Chat Session Helpers ────────────────────────────────────────────────────

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

  // Real chat activity. advance lastActivityAt so the session list sorts/
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
