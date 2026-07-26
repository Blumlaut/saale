import type { NextRequest } from "next/server";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { requireChatSessionOwner } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { saveCompactionMessage } from "@/lib/chat/compaction";
import { Prisma } from "@prisma/client";
import { registerActiveSession, unregisterActiveSession } from "@/lib/redis";
import { type ToolConfig } from "@/lib/pi/session";
import { resolveModelForPurpose } from "@/lib/pi/model-resolution";
import { normalizeToolResult, type ImageContent } from "@/lib/pi/message-replay";
import { readImageAsBase64 } from "@/lib/image-attachment";
import {
  getPoolKey,
  getSessionDir,
  createAndPool,
  get as getPoolEntry,
  getDispatcher,
} from "@/lib/pi/agent-pool";
import { createPersistentSession } from "@/lib/pi/persistent-session";
import { evaluatePromptGuard, evaluateReconnectAction } from "@/lib/pi/stream-logic";
import { saveAssistantMessage } from "@/lib/pi/stream-helpers";
import { getBufferedEvents } from "@/lib/pi/sse-buffer";
import { buildAgentSystemPrompt, clearProcessingSince } from "@/lib/pi/processing-state";
import { wrapWithApprovalGate, type ApprovalRequest } from "@/lib/pi/tool-approval-gate";
import { getDefaultPolicy } from "@/lib/pi/tool-infos";

/**
 * GET /api/chat/sessions/:sessionId/stream — SSE streaming endpoint
 *
 * Single unified path for both initial connections and reconnection.
 * Uses Last-Event-ID header for SSE-spec-compliant reconnection:
 * - Browser's EventSource automatically sends Last-Event-ID on reconnect
 * - Server replays buffered events from Redis sorted set
 * - Then subscribes to live agent events via the pooled dispatcher
 *
 * No separate Redis pub/sub reconnect path — the agent pool + SSE buffer
 * provide a single reliable source of truth.
 *
 * Emits: token, thinking, tool_start, tool_end, turn_end, message_saved, done,
 *         compaction_start, compaction_end, error, tool_approval_request
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await params;

  // ── Auth ──────────────────────────────────────────────────────────────
  const authResult = await requireChatSessionOwner(sessionId);
  if (!authResult.ok) return new Response("Unauthorized", { status: 401 });
  const chatSession = authResult.session;

  // ── User settings (system prompt + tool policies) ─────────────────────
  const userSettings = await prisma.appSettings.findUnique({
    where: { userId: authResult.userId },
    select: { agentCustomInstructions: true, toolPolicies: true },
  });

  const toolPolicies = userSettings?.toolPolicies as Record<string, "off" | "ask" | "allow"> | null;
  const getPolicy = async (toolName: string): Promise<"off" | "ask" | "allow"> =>
    toolPolicies?.[toolName] ?? getDefaultPolicy(toolName);

  // ── Dispatcher (per-session, survives across requests) ────────────────
  const dispatcher = getDispatcher(sessionId);

  // Approval wrapper — emits approval requests through the dispatcher
  const approvalWrapper = (tool: ToolDefinition): ToolDefinition =>
    wrapWithApprovalGate(tool, authResult.userId, sessionId, getPolicy, (req: ApprovalRequest) => {
      dispatcher.emit("tool_approval_request", {
        toolCallId: req.toolCallId,
        toolName: req.toolName,
        args: req.args,
        expiresAt: new Date(req.expiresAt).toISOString(),
      });
    });

  if (!chatSession) {
    return new Response("Not found", { status: 404 });
  }

  // ── Tool config ───────────────────────────────────────────────────────
  const resolvedToolConfig: ToolConfig = chatSession.toolConfig
    ? { ...(chatSession.toolConfig as ToolConfig) }
    : {};

  // ── Model resolution ──────────────────────────────────────────────────
  let modelProvider = chatSession.modelProvider || undefined;
  let modelName = chatSession.modelName || undefined;

  if (!modelProvider || !modelName) {
    const resolved = await resolveModelForPurpose(authResult.userId, "chat", undefined);
    if (resolved) {
      modelProvider = resolved.provider;
      modelName = resolved.name;
    }
  }

  // No model available — return an error stream
  if (!modelProvider || !modelName) {
    clearProcessingSince(sessionId).catch(console.error);

    const encoder = new TextEncoder();
    const errorEvent = encoder.encode(
      `event: error\ndata: ${JSON.stringify({ message: "No AI model configured. Please select a model in Settings > AI & Models." })}\n\n`,
    );
    const doneEvent = encoder.encode(`event: done\ndata: {}\n\n`);

    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(errorEvent);
          controller.enqueue(doneEvent);
          controller.close();
        },
      }),
      {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        },
      },
    );
  }

  // ── Debug log prefix ──────────────────────────────────────────────────
  const log = (tag: string, ...args: unknown[]) =>
    // eslint-disable-next-line no-console
    console.log(`[chat:${sessionId}] ${tag}`, ...args);

  // ── Agent pool ────────────────────────────────────────────────────────
  const poolKey = getPoolKey(authResult.userId, sessionId);
  const sessionDir = getSessionDir(authResult.userId, sessionId);

  const existingPoolEntry = getPoolEntry(poolKey);
  const pooled = await createAndPool(poolKey, async () => {
    log("pool", "miss — creating new agent");
    const result = await createPersistentSession({
      userId: authResult.userId,
      sessionId,
      sessionDir,
      customTools: [],
      toolConfig: resolvedToolConfig,
      modelProvider,
      modelName,
      thinkingLevel: chatSession.thinkingLevel || "off",
      wrapTool: approvalWrapper,
    });

    result.session.agent.state.systemPrompt = buildAgentSystemPrompt({
      customInstructions: userSettings?.agentCustomInstructions,
      toolConfig: resolvedToolConfig,
    });

    return { session: result.session, sessionDir };
  });

  if (existingPoolEntry) {
    log(
      "pool",
      `hit — isStreaming=${pooled.session.isStreaming}, lastPromptedMessageId=${pooled.lastPromptedMessageId}`,
    );
  }

  // ── Register session for cancellation ─────────────────────────────────
  await registerActiveSession(authResult.userId, sessionId);

  // ── Messages + prompt guard ───────────────────────────────────────────
  const messages = await prisma.chatMessage.findMany({
    where: { sessionId },
    orderBy: { createdAt: "asc" },
    include: {
      attachments: {
        select: {
          storagePath: true,
          mimeType: true,
        },
      },
    },
  });

  const lastMessage = messages[messages.length - 1];

  const promptGuard = evaluatePromptGuard(
    lastMessage
      ? {
          id: lastMessage.id,
          role: lastMessage.role as "user" | "assistant" | "toolResult" | "custom",
          content: lastMessage.content,
        }
      : undefined,
    pooled.lastPromptedMessageId,
  );
  const shouldPrompt = promptGuard.shouldPrompt;

  log(
    "prompt_guard",
    `shouldPrompt=${shouldPrompt} (${promptGuard.reason}), lastMessage.id=${lastMessage?.id}, role=${lastMessage?.role}, lastPromptedMessageId=${pooled.lastPromptedMessageId}`,
  );

  // ── Pre-load images for the current user message ──────────────────────
  const lastMessageImages: ImageContent[] = [];
  if (
    shouldPrompt &&
    lastMessage &&
    lastMessage.role === "user" &&
    lastMessage.attachments.length > 0
  ) {
    for (const att of lastMessage.attachments) {
      try {
        const { data, mimeType } = await readImageAsBase64(authResult.userId, att.storagePath);
        lastMessageImages.push({ type: "image" as const, data, mimeType });
      } catch (err) {
        console.error("Failed to load image for current message:", err);
      }
    }
  }

  // ── Reconnect: fetch buffered events (before creating the stream) ─────
  // ReadableStream's start() callback is synchronous, so we must fetch
  // buffered events here and replay them inside start() via emitSync().
  //
  // Last-Event-ID can come from:
  // 1. `Last-Event-ID` header (browser's EventSource sends this on auto-reconnect)
  // 2. `?lastEventId=N` query param (for manual reconnect from client-side logic)
  //    EventSource cannot send custom headers, so we use query params for manual reconnect.
  const lastEventIdHeader = request.headers.get("last-event-id");
  const url = new URL(request.url);
  const lastEventIdQuery = url.searchParams.get("lastEventId");
  const lastEventId = lastEventIdHeader
    ? parseInt(lastEventIdHeader, 10)
    : lastEventIdQuery
      ? parseInt(lastEventIdQuery, 10)
      : -1;
  const isReconnect = lastEventId >= 0;

  let bufferedEvents: { id: number; event: string; data: unknown }[] = [];
  let streamAlreadyFinished = false;

  // Replay buffered events in two scenarios:
  // 1. Explicit reconnect with lastEventId (browser auto-reconnect or manual ?lastEventId=N)
  // 2. Agent already processing but no lastEventId (page refresh, no auto-reconnect)
  //    In this case, replay ALL buffered events from the start.
  const needsBufferReplay = isReconnect || (!shouldPrompt && pooled.lastPromptedMessageId);

  if (needsBufferReplay) {
    const fromId = isReconnect ? lastEventId : -1;
    log("reconnect", `replaying buffer from id ${fromId} (isReconnect=${isReconnect})`);
    bufferedEvents = (await getBufferedEvents(sessionId, fromId)) || [];
    log("reconnect", `fetched ${bufferedEvents.length} buffered events`);

    // If the buffer contains a terminal event, the stream already ended
    for (const evt of bufferedEvents) {
      if (evt.event === "done" || evt.event === "error") {
        streamAlreadyFinished = true;
        break;
      }
    }
  }

  // ── Determine reconnect action (when not prompting) ───────────────────
  let emitDoneImmediately = false;
  if (!shouldPrompt && pooled.lastPromptedMessageId && !streamAlreadyFinished) {
    const reconnectAction = evaluateReconnectAction(
      pooled.session.isStreaming,
      pooled.lastPromptedMessageId,
    );
    if (reconnectAction.type === "emit-done") {
      emitDoneImmediately = true;
      log("prompt_guard", `reconnect: ${reconnectAction.reason}, emitting done`);
    } else {
      log("prompt_guard", `reconnect: ${reconnectAction.reason}, waiting for events`);
    }
  }

  // ── Seed saved turns from DB for reconnect ─────────────────────────────
  // When reconnecting, the buffer may contain turn_end events for turns
  // already saved to DB. Tell the client which turns are persisted so it
  // doesn't create duplicate streaming messages during buffer replay.
  let savedTurnsFromDb: number[] = [];
  if (!shouldPrompt && pooled.lastPromptedMessageId && !streamAlreadyFinished) {
    const assistantCount = await prisma.chatMessage.count({
      where: { sessionId, role: "assistant" },
    });
    if (assistantCount > 0) {
      savedTurnsFromDb = Array.from({ length: assistantCount }, (_, i) => i);
      log("reconnect", `seeded savedTurns from DB: [0..${assistantCount - 1}]`);
    }
  }

  // ── SSE stream state ──────────────────────────────────────────────────
  const encoder = new TextEncoder();

  function closeController(controller: ReadableStreamDefaultController): void {
    dispatcher.close();
    try {
      controller.close();
    } catch (err) {
      console.error("Failed to close controller (may already be closed):", err);
    }
  }

  // Tool call results tracking
  const toolCallResults: Map<
    string,
    { name: string; args: Record<string, unknown>; result?: string; isError?: boolean }
  > = new Map();

  // Token usage tracking
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalCacheWriteTokens = 0;
  let contextWindow = 0;

  // Turn state
  let turnIndex = 0;
  let currentTurnText = "";
  let currentTurnThinking = "";
  const currentTurnToolCallIds = new Set<string>();
  let rootMessageId: string | null = null;

  // Guard: agent_end DB persistence runs exactly once across all SSE connections
  let agentEndPersisted = false;

  // Track all pending DB saves so we can await them before emitting "done"
  const pendingSaves: Promise<void>[] = [];

  // Promise that resolves when agent_end persistence completes.
  // Used by reconnect paths to wait for DB save before emitting "done".
  let agentEndResolve: (() => void) | null = null;
  const agentEndPromise = new Promise<void>((resolve) => {
    agentEndResolve = resolve;
  });

  // Throttle: ~5/sec to keep UI responsive
  const TOKEN_THROTTLE_MS = 200;
  let lastTokenSend = 0;
  let lastThinkingSend = 0;

  // ── Create SSE stream ─────────────────────────────────────────────────
  const stream = new ReadableStream({
    start(controller) {
      // Wire dispatcher to this controller — replaces any old connection
      dispatcher.wire(controller, encoder);

      // ── Replay buffered events (reconnect path) ──────────────────────
      if (bufferedEvents.length > 0) {
        // Tell the client which turns are already persisted BEFORE replaying
        // buffer events, so turn_end handlers don't create duplicate messages.
        if (savedTurnsFromDb.length > 0) {
          dispatcher.emitSync("saved_turns", { turns: savedTurnsFromDb }, -1);
        }
        for (const evt of bufferedEvents) {
          dispatcher.emitSync(evt.event, evt.data, evt.id);
        }
      }

      // ── Terminal: stream already finished in buffer ───────────────────
      if (streamAlreadyFinished) {
        log("reconnect", "stream already finished in buffer, closing");
        // Wait for agent_end persistence before closing
        void agentEndPromise.then(() => {
          closeController(controller);
        });
        return;
      }

      // ── Terminal: agent already finished ──────────────────────────────
      if (emitDoneImmediately) {
        // Wait for agent_end persistence before emitting done
        void agentEndPromise.then(() => {
          dispatcher.emit("done", {});
          closeController(controller);
        });
        return;
      }

      // ── Subscribe to agent events ─────────────────────────────────────
      const unsubscribeSse = pooled.session.subscribe((event) => {
        log(
          "event",
          event.type,
          "message" in event && event.message ? { role: event.message.role } : undefined,
        );

        switch (event.type) {
          // ── Token usage tracking ────────────────────────────────────────
          case "message_end": {
            if (event.message.role !== "assistant") break;

            const msg = event.message as unknown as Record<string, unknown>;
            const usage = msg.usage as Record<string, number> | undefined;
            if (!usage) break;

            totalInputTokens += usage.input ?? 0;
            totalOutputTokens += usage.output ?? 0;
            totalCacheReadTokens += usage.cacheRead ?? 0;
            totalCacheWriteTokens += usage.cacheWrite ?? 0;

            if (!contextWindow) {
              contextWindow = pooled.session.model?.contextWindow ?? 0;
            }

            dispatcher.emit("token_usage", {
              input: totalInputTokens,
              output: totalOutputTokens,
              cacheRead: totalCacheReadTokens,
              cacheWrite: totalCacheWriteTokens,
              total: totalInputTokens + totalOutputTokens,
              contextWindow,
            });

            // Auto-compaction at 85% context window
            const compactionThreshold = contextWindow * 0.85;
            if (totalInputTokens + totalOutputTokens > compactionThreshold) {
              log(
                "compaction",
                `auto-triggering (${totalInputTokens + totalOutputTokens}/${contextWindow})`,
              );
              pooled.session
                .compact()
                .then((result) => {
                  log(
                    "compaction",
                    `completed: ${result?.tokensBefore ?? "unknown"} tokens before`,
                  );
                })
                .catch((err) => {
                  console.error("Auto-compaction failed:", err);
                });
            }
            break;
          }

          // ── Streaming text + thinking ───────────────────────────────────
          case "message_update": {
            if (event.message.role !== "assistant") return;
            const msg = event.message as { content: unknown[] };

            // Thinking
            const thinkingBlock = msg.content.find(
              (c) =>
                typeof c === "object" &&
                c !== null &&
                (c as Record<string, unknown>).type === "thinking",
            );
            if (thinkingBlock && typeof thinkingBlock === "object" && "thinking" in thinkingBlock) {
              currentTurnThinking = (thinkingBlock as Record<string, unknown>).thinking as string;
              const now = Date.now();
              if (now - lastThinkingSend >= TOKEN_THROTTLE_MS) {
                lastThinkingSend = now;
                dispatcher.emit("thinking", { thinking: currentTurnThinking });
              }
            }

            // Cumulative text
            const textBlocks = msg.content.filter(
              (c) =>
                typeof c === "object" &&
                c !== null &&
                (c as Record<string, unknown>).type === "text",
            );
            currentTurnText = textBlocks
              .map((c) => ((c as Record<string, unknown>).text as string) || "")
              .join("");
            if (currentTurnText) {
              const now = Date.now();
              if (now - lastTokenSend >= TOKEN_THROTTLE_MS) {
                lastTokenSend = now;
                dispatcher.emit("token", { text: currentTurnText });
              }
            }

            // Track tool call IDs
            for (const content of msg.content) {
              if (
                typeof content === "object" &&
                content !== null &&
                (content as Record<string, unknown>).type === "toolCall"
              ) {
                currentTurnToolCallIds.add((content as Record<string, unknown>).id as string);
              }
            }
            break;
          }

          // ── Tool execution ──────────────────────────────────────────────
          case "tool_execution_start": {
            toolCallResults.set(event.toolCallId, {
              name: event.toolName,
              args: event.args,
            });
            dispatcher.emit("tool_start", {
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              args: event.args,
            });

            // Persist active tool to DB (for page refresh mid-tool)
            prisma.chatSession
              .update({
                where: { id: sessionId },
                data: {
                  activeToolCallId: event.toolCallId,
                  activeToolName: event.toolName,
                  activeToolArgs: event.args,
                  activeToolStartedAt: new Date(),
                },
              })
              .catch((err) => {
                console.error("Failed to persist active tool state:", err);
              });
            break;
          }

          case "tool_execution_end": {
            const resultStr = normalizeToolResult(event.result);
            const existing = toolCallResults.get(event.toolCallId);
            if (existing) {
              existing.result = resultStr;
              existing.isError = event.isError;
            }
            dispatcher.emit("tool_end", {
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              result: resultStr,
              isError: event.isError,
            });

            // Clear active tool from DB
            prisma.chatSession
              .update({
                where: { id: sessionId },
                data: {
                  activeToolCallId: null,
                  activeToolName: null,
                  activeToolArgs: Prisma.JsonNull,
                  activeToolStartedAt: null,
                },
              })
              .catch((err) => {
                console.error("Failed to clear active tool state:", err);
              });
            break;
          }

          // ── Turn boundary ───────────────────────────────────────────────
          case "turn_end": {
            log("turn_end", `turnIndex=${turnIndex}, textLen=${currentTurnText.length}`);

            // Flush final token/thinking before turn_end so the client
            // receives the complete text (throttle may have prevented the
            // last message_update tick from emitting).
            if (currentTurnText) {
              dispatcher.emit("token", { text: currentTurnText });
            }
            if (currentTurnThinking) {
              dispatcher.emit("thinking", { thinking: currentTurnThinking });
            }

            const assistantMsg =
              event.message.role === "assistant" ? (event.message as { content: unknown[] }) : null;
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

            // Save to DB, then notify client with the real ID
            const turnIndexForSave = turnIndex;
            pendingSaves.push(
              saveAssistantMessage(
                sessionId,
                currentTurnText,
                currentTurnThinking || undefined,
                turnToolCalls.length > 0 ? turnToolCalls : undefined,
                rootMessageId,
              )
                .then((msg) => {
                  log("db_save", `turnIndex=${turnIndexForSave}, msgId=${msg.id}`);
                  if (!rootMessageId) {
                    rootMessageId = msg.id;
                  }
                  // Notify client that this turn's message is persisted
                  dispatcher.emit("message_saved", {
                    messageId: msg.id,
                    turnIndex: turnIndexForSave,
                  });
                })
                .catch((err) => {
                  console.error(
                    `Failed to save assistant message for turn ${turnIndexForSave}:`,
                    err,
                  );
                }),
            );

            dispatcher.emit("turn_end", {
              turnIndex,
              text: currentTurnText,
              thinking: currentTurnThinking || null,
              toolCalls: turnToolCalls,
            });

            turnIndex++;
            currentTurnText = "";
            currentTurnThinking = "";
            currentTurnToolCallIds.clear();
            break;
          }

          // ── Compaction ──────────────────────────────────────────────────
          case "compaction_start": {
            dispatcher.emit("compaction_start", { reason: event.reason });
            break;
          }

          case "compaction_end": {
            if (event.result && !event.aborted) {
              void saveCompactionMessage({
                sessionId,
                summary: event.result.summary,
                tokensBefore: event.result.tokensBefore,
              });

              dispatcher.emit("compaction_end", {
                reason: event.reason,
                tokensBefore: event.result.tokensBefore,
                summary: event.result.summary,
                aborted: false,
                errorMessage: undefined,
              });
            } else {
              dispatcher.emit("compaction_end", {
                reason: event.reason,
                tokensBefore: undefined,
                summary: undefined,
                aborted: event.aborted,
                errorMessage: event.errorMessage,
              });
            }

            clearProcessingSince(sessionId).catch((err) => {
              console.error("Failed to clear processingSince after compaction:", err);
            });
            break;
          }

          // ── Agent finished (SSE forwarding — just log) ─────────────────
          case "agent_end": {
            log("agent_end", `totalMessages=${event.messages.length}, turnIndex=${turnIndex}`);
            break;
          }
        }
      });

      // ── Agent-end persistence (survives client disconnect) ─────────────
      const unsubscribeAgentEnd = pooled.session.subscribe((event) => {
        if (event.type !== "agent_end") return;

        // Atomic guard: only the first agent_end handler persists to DB
        if (!agentEndPersisted) {
          agentEndPersisted = true;
          log("agent_end", `persisting to DB (totalMessages=${event.messages.length})`);

          const assistantMessages = event.messages
            .filter((m) => m.role === "assistant")
            .map((m) => m as { role: "assistant"; content: unknown[] });
          const lastAssistant = assistantMessages[assistantMessages.length - 1];

          if (lastAssistant) {
            const textBlocks = lastAssistant.content.filter(
              (c) =>
                typeof c === "object" &&
                c !== null &&
                (c as Record<string, unknown>).type === "text",
            );
            const finalText = textBlocks
              .map((c) => ((c as Record<string, unknown>).text as string) || "")
              .join("");

            const thinkingBlock = lastAssistant.content.find(
              (c) =>
                typeof c === "object" &&
                c !== null &&
                (c as Record<string, unknown>).type === "thinking",
            );
            const finalThinking =
              thinkingBlock && typeof thinkingBlock === "object" && "thinking" in thinkingBlock
                ? ((thinkingBlock as Record<string, unknown>).thinking as string)
                : "";

            const toolCallBlocks = lastAssistant.content.filter(
              (c) =>
                typeof c === "object" &&
                c !== null &&
                (c as Record<string, unknown>).type === "toolCall",
            ) as Record<string, unknown>[];
            const toolCalls = toolCallBlocks.map((tc) => {
              const result = toolCallResults.get(tc.id as string);
              return {
                id: tc.id as string,
                name: tc.name as string,
                args: tc.arguments as unknown as Record<string, unknown>,
                result: result?.result,
                isError: result?.isError,
              };
            });

            // Always finalize: update existing message (multi-turn) or create new (single-turn).
            // turn_end saves with turn-level content (may be empty text + tool calls).
            // agent_end has the final accumulated content from all turns.
            const existingMessageId = rootMessageId ?? undefined;
            pendingSaves.push(
              saveAssistantMessage(
                sessionId,
                finalText,
                finalThinking || undefined,
                toolCalls.length > 0 ? toolCalls : undefined,
                null,
                existingMessageId,
              )
                .then((msg) => {
                  log(
                    "db_save",
                    `agent_end ${existingMessageId ? "updated" : "created"} msgId=${msg.id}`,
                  );
                  const turnIndexForSave = existingMessageId ? turnIndex - 1 : 0;
                  dispatcher.emit("message_saved", {
                    messageId: msg.id,
                    turnIndex: Math.max(0, turnIndexForSave),
                  });
                })
                .catch((err) => {
                  console.error("Failed to save agent_end assistant message:", err);
                }),
            );
          }

          // Always clear processingSince and increment message count
          Promise.all([
            clearProcessingSince(sessionId),
            prisma.chatSession.update({
              where: { id: sessionId },
              data: { messageCount: { increment: turnIndex || 1 } },
            }),
          ]).catch(console.error);

          unregisterActiveSession(authResult.userId, sessionId).catch(console.error);
        }

        // Wait for all DB saves to complete before emitting "done"
        // This ensures message_saved events arrive before the client cleans up
        void Promise.allSettled(pendingSaves).then(() => {
          // Signal that agent_end persistence is complete
          agentEndResolve?.();
          dispatcher.emit("done", {});
          closeController(controller);
          unsubscribeAgentEnd();
          unsubscribeSse();
        });
      });

      // ── Send prompt or wait for events ─────────────────────────────────
      if (shouldPrompt && lastMessage && lastMessage.role === "user") {
        pooled.lastPromptedMessageId = lastMessage.id;
        log("prompt", `sending prompt, message.id=${lastMessage.id}`);

        const promptPromise =
          lastMessageImages.length > 0
            ? pooled.session.agent.prompt(lastMessage.content, lastMessageImages)
            : pooled.session.agent.prompt(lastMessage.content);

        promptPromise
          .then(() => {
            log("prompt", "agent.prompt() resolved");
          })
          .catch((err) => {
            console.error("agent.prompt() failed:", err);
            unsubscribeSse();
            unsubscribeAgentEnd();
            clearProcessingSince(sessionId).catch((updateErr) => {
              console.error("Failed to clear processingSince on error:", updateErr);
            });
            unregisterActiveSession(authResult.userId, sessionId).catch(console.error);
            dispatcher.emit("error", { message: err.message });
            dispatcher.emit("done", {});
            closeController(controller);
          });
      }

      // ── Client disconnect ──────────────────────────────────────────────
      request.signal.addEventListener("abort", () => {
        log("client", "disconnect detected, stopping SSE forwarding (agent continues)");
        unsubscribeSse();
        closeController(controller);
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
