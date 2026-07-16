import type { NextRequest } from "next/server";
import { requireChatSessionOwner } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { registerActiveSession, unregisterActiveSession } from "@/lib/redis";
import { type ToolConfig } from "@/lib/pi/session";
import { resolveModelForPurpose } from "@/lib/pi/model-resolution";
import { normalizeToolResult, type ImageContent } from "@/lib/pi/message-replay";
import { readImageAsBase64 } from "@/lib/image-attachment";
import { getPoolKey, getSessionDir, createAndPool, get as getPoolEntry } from "@/lib/pi/agent-pool";
import { createPersistentSession } from "@/lib/pi/persistent-session";
import {
  evaluatePromptGuard,
  evaluateReconnectAction,
  formatSseEvent,
} from "@/lib/pi/stream-logic";
import {
  publishStreamEvent,
  handleReconnectFromRedis,
  saveAssistantMessage,
} from "@/lib/pi/stream-helpers";

/**
 * GET /api/chat/sessions/:sessionId/stream — SSE streaming endpoint
 *
 * Streams Pi agent responses as Server-Sent Events.
 * Uses long-lived agents backed by Pi's file-based SessionManager.
 * Emits: token, thinking, tool_start, tool_end, turn_end, done, compaction_start, compaction_end
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await params;

  const authResult = await requireChatSessionOwner(sessionId);
  if (!authResult.ok) return new Response("Unauthorized", { status: 401 });
  const chatSession = authResult.session;

  // Fetch user's custom agent system prompt
  const userSettings = await prisma.appSettings.findUnique({
    where: { userId: authResult.userId },
    select: { agentCustomInstructions: true },
  });

  if (!chatSession) {
    return new Response("Not found", { status: 404 });
  }

  // Resolve tool config
  const resolvedToolConfig: ToolConfig = chatSession.toolConfig
    ? { ...(chatSession.toolConfig as ToolConfig) }
    : {};

  // Resolve model: session-level first, then fall back to user/admin defaults
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
    // Clear in-progress flag so the user can try again
    prisma.chatSession
      .update({ where: { id: sessionId }, data: { processingSince: null } })
      .catch(console.error);

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

  // Debug log prefix
  const log = (tag: string, ...args: unknown[]) =>
    // eslint-disable-next-line no-console
    console.log(`[chat:${sessionId}] ${tag}`, ...args);

  // Check for reconnect request
  const url = new URL(request.url);
  const isReconnect = url.searchParams.get("reconnect") === "1";

  if (isReconnect && chatSession.processingSince) {
    // Reconnect: the primary stream handler publishes events to Redis.
    // The reconnected client subscribes to Redis pub/sub for catch-up.
    // This works whether the agent is in the pool (same process) or not (restart).
    //
    // However, if the agent is in the pool and already finished (isStreaming=false),
    // processingSince may be stale (DB update hasn't flushed yet). In that case,
    // skip the Redis path and fall through to the primary path which will emit done.
    const poolKey = getPoolKey(authResult.userId, sessionId);
    const pooledForCheck = getPoolEntry(poolKey);
    if (pooledForCheck && !pooledForCheck.session.isStreaming) {
      log(
        "reconnect",
        "processingSince is set but agent in pool is finished (isStreaming=false) — using primary path",
      );
      // Fall through to primary path below
    } else {
      return handleReconnectFromRedis(sessionId, request);
    }
  }

  // ── Primary stream path ──────────────────────────────────────────────

  const poolKey = getPoolKey(authResult.userId, sessionId);
  const sessionDir = getSessionDir(authResult.userId, sessionId);

  // Get or create pooled agent
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
    });

    // Set system prompt on the agent
    const defaultSystemPrompt = `You are Saale, a personal AI assistant built into a productivity workspace. You help with chat, email drafting, job management, calendar, and file organization.

Guidelines:
- Be concise and direct — get to the point without unnecessary preamble.
- Write naturally, like a capable colleague, not a generic AI.
- Use bullet points or short paragraphs when listing things.
- When uncertain, say so briefly rather than guessing.
- Match the user's tone and language preference.`;

    const customInstructions =
      userSettings?.agentCustomInstructions && userSettings.agentCustomInstructions.trim()
        ? "\n\nCustom instructions:\n" + userSettings.agentCustomInstructions
        : "";

    const terminalInstruction =
      resolvedToolConfig.terminal === true
        ? "\n\nA Terminal is available to run commands and read/write files. Common utilities such as bash, wget, curl, python, yt-dlp.. are available."
        : "";

    const memoryInstruction =
      resolvedToolConfig.memory !== false
        ? "\n\nYou have a persistent memory system. If the user references something you don't know about, use `memory_search` to look it up before answering."
        : "";

    result.session.agent.state.systemPrompt =
      defaultSystemPrompt + customInstructions + terminalInstruction + memoryInstruction;

    return { session: result.session, sessionDir };
  });

  if (existingPoolEntry) {
    log(
      "pool",
      `hit — isStreaming=${pooled.session.isStreaming}, lastPromptedMessageId=${pooled.lastPromptedMessageId}`,
    );
  }
  log("pool", "lastPromptedMessageId=", pooled.lastPromptedMessageId);

  // Register session for explicit cancellation (stop endpoint)
  await registerActiveSession(authResult.userId, sessionId);

  // Get the latest user message from DB (the one to prompt with)
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

  // Double-prompting guard: only prompt if this message hasn't been processed
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
    `shouldPrompt=${shouldPrompt} (${promptGuard.reason}), lastMessage.id=${lastMessage?.id}, role=${lastMessage?.role}, lastPromptedMessageId=${pooled.lastPromptedMessageId}, dbMessages=${messages.length}`,
  );

  // Pre-load images for the current (last) user message.
  // Must be done outside the stream's start() callback (which is not async).
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

  // Create SSE stream
  const encoder = new TextEncoder();
  let clientDisconnected = false;
  let controllerClosed = false;

  /**
   * Send an SSE event with proper escaping and publish to Redis for reconnection.
   * SSE spec: a line containing only "\n" terminates the event block.
   * JSON.stringify can produce \n inside strings (from tool results, etc.),
   * which would prematurely terminate the event and inject a new one.
   * We escape literal newlines in the JSON payload to prevent this.
   */
  function sendEvent(
    controller: ReadableStreamDefaultController,
    event: string,
    data: unknown,
  ): void {
    if (clientDisconnected || controllerClosed) return;
    try {
      controller.enqueue(encoder.encode(formatSseEvent(event, data)));
    } catch (err) {
      // Controller may have been closed by another handler (race condition)
      console.error("Failed to enqueue SSE event (controller may be closed):", err);
    }

    // Publish to Redis for reconnecting clients (fire-and-forget)
    publishStreamEvent(sessionId, event, data).catch(console.error);
  }

  /**
   * Safely close the controller (idempotent — won't throw if already closed).
   */
  function closeController(controller: ReadableStreamDefaultController): void {
    if (controllerClosed) return;
    controllerClosed = true;
    try {
      controller.close();
    } catch (err) {
      console.error("Failed to close controller (may already be closed):", err);
    }
  }

  // Track tool call results for the final message
  const toolCallResults: Map<
    string,
    { name: string; args: Record<string, unknown>; result?: string; isError?: boolean }
  > = new Map();

  // Track turn state
  let turnIndex = 0;
  let currentTurnText = "";
  let currentTurnThinking = "";
  // Track tool calls that belong to the current turn (by toolCallId)
  const currentTurnToolCallIds = new Set<string>();

  // Root assistant message ID (first turn's DB message id, used as parentMessageId for subsequent turns)
  let rootMessageId: string | null = null;

  // Guard to ensure agent_end DB persistence runs exactly once across all SSE connections.
  // Multiple connections can exist (original + reconnects); each has its own agent_end listener.
  // Only the first to fire should save to DB and clear processingSince.
  let agentEndPersisted = false;

  // Throttle SSE token/thinking events to prevent flooding the frontend.
  // message_update fires ~20/sec; throttling to ~5/sec (200ms) keeps the UI responsive
  // by avoiding excessive markdown re-parses on the client.
  const TOKEN_THROTTLE_MS = 200;
  let lastTokenSend = 0;
  let lastThinkingSend = 0;

  const stream = new ReadableStream({
    start(controller) {
      // Subscribe to agent events for SSE forwarding (token, thinking, tool events).
      // This is unsubscribed on client disconnect.
      const unsubscribeSse = pooled.session.subscribe((event) => {
        log(
          "event",
          event.type,
          "message" in event && event.message ? { role: event.message.role } : undefined,
        );
        switch (event.type) {
          case "message_update": {
            if (event.message.role !== "assistant") return;
            // Narrow to assistant message with content array
            const msg = event.message as { content: unknown[] };

            // Extract thinking content
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
                sendEvent(controller, "thinking", { thinking: currentTurnThinking });
              }
            }

            // Extract cumulative text from all text blocks
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
                sendEvent(controller, "token", { text: currentTurnText });
              }
            }

            // Track tool call IDs appearing in this message
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

          case "tool_execution_start": {
            toolCallResults.set(event.toolCallId, {
              name: event.toolName,
              args: event.args,
            });
            sendEvent(controller, "tool_start", {
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              args: event.args,
            });
            break;
          }

          case "tool_execution_end": {
            // Normalize result to string for consistent frontend typing.
            const resultStr = normalizeToolResult(event.result);
            const existing = toolCallResults.get(event.toolCallId);
            if (existing) {
              existing.result = resultStr;
              existing.isError = event.isError;
            }
            sendEvent(controller, "tool_end", {
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              result: resultStr,
              isError: event.isError,
            });
            break;
          }

          case "turn_end": {
            log(
              "turn_end",
              `turnIndex=${turnIndex}, textLen=${currentTurnText.length}, thinkingLen=${(currentTurnThinking || "").length}`,
            );
            // Collect tool calls for this turn from the message content
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

            // Save this turn's message to DB
            const savedMessage = saveAssistantMessage(
              sessionId,
              currentTurnText,
              currentTurnThinking || undefined,
              turnToolCalls.length > 0 ? turnToolCalls : undefined,
              rootMessageId, // parentMessageId (null for first turn)
            );

            savedMessage.then((msg) => {
              log(
                "db_save",
                `turnIndex=${turnIndex}, msgId=${msg.id}, textPreview=${currentTurnText.slice(0, 50)}`,
              );
              if (!rootMessageId) {
                rootMessageId = msg.id;
              }
            });

            // Emit turn_end event to frontend
            sendEvent(controller, "turn_end", {
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

          case "compaction_start": {
            sendEvent(controller, "compaction_start", { reason: event.reason });
            break;
          }

          case "compaction_end": {
            sendEvent(controller, "compaction_end", {
              reason: event.reason,
              tokensBefore: event.result?.tokensBefore,
              aborted: event.aborted,
              errorMessage: event.errorMessage,
            });
            break;
          }

          case "agent_end": {
            // DB persistence is handled by the separate agent_end listener below.
            // This SSE forwarding handler just logs — the separate listener emits done.
            log("agent_end", `totalMessages=${event.messages.length}, turnIndex=${turnIndex}`);
            break;
          }
        }
      });

      // Separate subscription for agent_end DB persistence.
      // This survives client disconnects — ensures the final message is ALWAYS saved
      // even if the SSE client refreshes/navigates away mid-stream.
      const unsubscribeAgentEnd = pooled.session.subscribe((event) => {
        if (event.type !== "agent_end") return;

        // Atomic guard: only the first agent_end handler (across all SSE connections)
        // persists to DB. This prevents duplicate saves when old + new listeners both fire.
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

            // Save if no turn_end events fired (single-turn response)
            if (turnIndex === 0) {
              saveAssistantMessage(
                sessionId,
                finalText,
                finalThinking || undefined,
                toolCalls.length > 0 ? toolCalls : undefined,
                null,
              ).catch(console.error);
            }

            prisma.chatSession
              .update({
                where: { id: sessionId },
                data: {
                  messageCount: { increment: turnIndex || 1 },
                  processingSince: null,
                },
              })
              .catch(console.error);
          }

          unregisterActiveSession(authResult.userId, sessionId).catch(console.error);
        }

        // Always send done to this SSE client (safe — sendEvent catches closed controller)
        sendEvent(controller, "done", {});
        closeController(controller);

        // Clean up this listener
        unsubscribeAgentEnd();
        // Also clean up SSE forwarding if still active
        unsubscribeSse();
      });

      // Send the user message to the agent (only if this is a new message)
      if (shouldPrompt && lastMessage && lastMessage.role === "user") {
        // Track that we've prompted this message
        pooled.lastPromptedMessageId = lastMessage.id;
        log(
          "prompt",
          `sending prompt, message.id=${lastMessage.id}, content=${lastMessage.content?.slice(0, 60)}`,
        );

        // Use agent.prompt() directly to bypass AgentSession's preflight logic
        // which resets systemPrompt back to the Pi base prompt on every turn.
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
            // Unsubscribe both listeners to prevent leak
            unsubscribeSse();
            unsubscribeAgentEnd();
            // Clear in-progress flag so the user can retry
            prisma.chatSession
              .update({ where: { id: sessionId }, data: { processingSince: null } })
              .catch((updateErr) => {
                console.error("Failed to clear processingSince on error:", updateErr);
              });
            unregisterActiveSession(authResult.userId, sessionId).catch(console.error);
            sendEvent(controller, "error", { message: err.message });
            sendEvent(controller, "done", {});
            closeController(controller);
          });
      } else if (!shouldPrompt && pooled.lastPromptedMessageId) {
        // Reconnect case — agent already processed this message.
        // Subscribe to events is already active above (catches in-progress turns).
        const reconnectAction = evaluateReconnectAction(
          pooled.session.isStreaming,
          pooled.lastPromptedMessageId,
        );
        if (reconnectAction.type === "emit-done") {
          // agent_end was emitted to the previous client — this new subscription
          // won't see it, so emit done immediately.
          log("prompt_guard", `reconnect: ${reconnectAction.reason}, emitting done`);
          // Agent already finished — unsubscribe both and emit done
          unsubscribeSse();
          unsubscribeAgentEnd();
          sendEvent(controller, "done", {});
          closeController(controller);
        } else {
          log("prompt_guard", `reconnect: ${reconnectAction.reason}, waiting for events`);
        }
      }

      // Handle client disconnect — stop SSE forwarding but keep the agent_end
      // listener alive so the final message is still saved to the database.
      request.signal.addEventListener("abort", () => {
        log("client", "disconnect detected, stopping SSE forwarding (agent continues)");
        clientDisconnected = true;
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
