import { NextRequest } from "next/server";
import { requireSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import {
  createRedisClient,
  getRedis,
  registerActiveSession,
  unregisterActiveSession,
} from "@/lib/redis";
import { type ToolConfig } from "@/lib/pi/session";
import { resolveModelForPurpose } from "@/lib/pi/model-resolution";
import { normalizeToolResult, type ImageContent } from "@/lib/pi/message-replay";
import { readImageAsBase64 } from "@/lib/image-attachment";
import { getPoolKey, getSessionDir, createAndPool, get as getPoolEntry } from "@/lib/pi/agent-pool";
import { createPersistentSession } from "@/lib/pi/persistent-session";

/**
 * Redis pub/sub for SSE reconnection.
 *
 * Every SSE event is published to `chat:stream:{sessionId}` so that multiple
 * SSE clients (original + reconnecting after refresh) receive the same events.
 * Events are also buffered in a Redis list for catch-up on reconnect.
 */
const STREAM_CHANNEL_PREFIX = "chat:stream:";
const BUFFER_KEY_PREFIX = "chat:stream:buf:";
const BUFFER_TTL_SECONDS = 60; // keep buffer for 60s
const BUFFER_MAX_SIZE = 200; // max events in buffer

/** Publish an SSE-formatted event to Redis for other clients to receive. */
async function publishStreamEvent(sessionId: string, event: string, data: unknown): Promise<void> {
  try {
    const redis = getRedis();
    const payload = JSON.stringify({ event, data });
    const channel = `${STREAM_CHANNEL_PREFIX}${sessionId}`;
    await redis.publish(channel, payload);

    // Buffer event for reconnecting clients
    const bufKey = `${BUFFER_KEY_PREFIX}${sessionId}`;
    await redis.lpush(bufKey, payload);
    await redis.ltrim(bufKey, 0, BUFFER_MAX_SIZE - 1);
    await redis.expire(bufKey, BUFFER_TTL_SECONDS);
  } catch (err) {
    console.error("Redis publish error:", err);
  }
}

/** Get buffered events for a session (oldest first). */
async function getBufferedEvents(sessionId: string): Promise<string[]> {
  try {
    const redis = getRedis();
    const bufKey = `${BUFFER_KEY_PREFIX}${sessionId}`;
    const events = await redis.lrange(bufKey, 0, -1);
    return events.reverse(); // lrange returns newest first after lpush
  } catch (err) {
    console.error("Redis buffer read error:", err);
    return [];
  }
}

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
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const { sessionId } = await params;

  const chatSession = await prisma.chatSession.findFirst({
    where: { id: sessionId, userId: authResult.user.id },
    select: {
      id: true,
      modelProvider: true,
      modelName: true,
      thinkingLevel: true,
      toolConfig: true,
      processingSince: true,
    },
  });

  // Fetch user's custom agent system prompt
  const userSettings = await prisma.appSettings.findUnique({
    where: { userId: authResult.user.id },
    select: { agentSystemPrompt: true },
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
    const resolved = await resolveModelForPurpose(authResult.user.id, "chat", undefined);
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

  // Check for reconnect request
  const url = new URL(request.url);
  const isReconnect = url.searchParams.get("reconnect") === "1";

  if (isReconnect && chatSession.processingSince) {
    // Reconnect: the primary stream handler publishes events to Redis.
    // The reconnected client subscribes to Redis pub/sub for catch-up.
    // This works whether the agent is in the pool (same process) or not (restart).
    return handleReconnectFromRedis(sessionId, request);
  }

  // ── Primary stream path ──────────────────────────────────────────────

  const poolKey = getPoolKey(authResult.user.id, sessionId);
  const sessionDir = getSessionDir(authResult.user.id, sessionId);

  // Debug log prefix (temporary — remove after investigating duplication bug)
  const log = (tag: string, ...args: unknown[]) =>
    // eslint-disable-next-line no-console
    console.log(`[chat:${sessionId}] ${tag}`, ...args);

  // Get or create pooled agent
  const existingPoolEntry = getPoolEntry(poolKey);
  const pooled = await createAndPool(poolKey, async () => {
    log("pool", "miss — creating new agent");
    const result = await createPersistentSession({
      userId: authResult.user.id,
      sessionId,
      sessionDir,
      customTools: [],
      toolConfig: resolvedToolConfig,
      modelProvider,
      modelName,
      thinkingLevel: chatSession.thinkingLevel || "off",
    });

    // Set system prompt on the agent
    const defaultSystemPrompt =
      "You are a helpful AI assistant. Be concise, direct, and write natural responses.";
    const basePrompt =
      userSettings?.agentSystemPrompt && userSettings.agentSystemPrompt.trim()
        ? userSettings.agentSystemPrompt
        : defaultSystemPrompt;

    const memoryInstruction =
      resolvedToolConfig.memory !== false
        ? "\n\nYou have a persistent memory system. If the user references something you don't know about, use `memory_search` to look it up before answering."
        : "";

    result.session.agent.state.systemPrompt = basePrompt + memoryInstruction;

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
  await registerActiveSession(authResult.user.id, sessionId);

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
  let shouldPrompt = false;
  if (lastMessage && lastMessage.role === "user") {
    if (pooled.lastPromptedMessageId !== lastMessage.id) {
      shouldPrompt = true;
    }
  }

  log(
    "prompt_guard",
    `shouldPrompt=${shouldPrompt}, lastMessage.id=${lastMessage?.id}, role=${lastMessage?.role}, lastPromptedMessageId=${pooled.lastPromptedMessageId}, dbMessages=${messages.length}`,
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
        const { data, mimeType } = await readImageAsBase64(authResult.user.id, att.storagePath);
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
    const json = JSON.stringify(data);
    // Replace literal newlines with \n to prevent SSE event termination
    const escaped = json.replace(/\n/g, "\\n").replace(/\r/g, "\\r");
    try {
      controller.enqueue(encoder.encode(`event: ${event}\ndata: ${escaped}\n\n`));
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

  const stream = new ReadableStream({
    start(controller) {
      // Subscribe to agent events — capture unsubscribe to prevent listener leak
      // (pooled sessions survive across requests; old listeners must be removed)
      const unsubscribe = pooled.session.subscribe((event) => {
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
              sendEvent(controller, "thinking", { thinking: currentTurnThinking });
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
              sendEvent(controller, "token", { text: currentTurnText });
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
            log("agent_end", `totalMessages=${event.messages.length}, turnIndex=${turnIndex}`);
            // Get final assistant message(s)
            const assistantMessages = event.messages
              .filter((m) => m.role === "assistant")
              .map((m) => m as { role: "assistant"; content: unknown[] });
            const lastAssistant = assistantMessages[assistantMessages.length - 1];

            if (lastAssistant) {
              // Extract final text
              const textBlocks = lastAssistant.content.filter(
                (c) =>
                  typeof c === "object" &&
                  c !== null &&
                  (c as Record<string, unknown>).type === "text",
              );
              const finalText = textBlocks
                .map((c) => ((c as Record<string, unknown>).text as string) || "")
                .join("");

              // Extract thinking
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

              // Extract tool calls from the message content
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

              // If there were no turn_end events (single-turn response with no tools),
              // save the message here
              if (turnIndex === 0) {
                saveAssistantMessage(
                  sessionId,
                  finalText,
                  finalThinking || undefined,
                  toolCalls.length > 0 ? toolCalls : undefined,
                  null,
                ).catch(console.error);
              }

              // Update message count and clear in-progress flag
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

            // Clean up Redis tracking (agent stays in pool for reuse)
            unregisterActiveSession(authResult.user.id, sessionId).catch(console.error);

            // Unsubscribe to prevent listener leak on pooled sessions
            unsubscribe();

            sendEvent(controller, "done", {});
            closeController(controller);
            break;
          }
        }
      });

      // Send the user message to the agent (only if this is a new message)
      if (shouldPrompt && lastMessage && lastMessage.role === "user") {
        // Track that we've prompted this message
        pooled.lastPromptedMessageId = lastMessage.id;
        log(
          "prompt",
          `sending prompt, message.id=${lastMessage.id}, content=${lastMessage.content?.slice(0, 60)}`,
        );

        const promptPromise =
          lastMessageImages.length > 0
            ? pooled.session.prompt(lastMessage.content, { images: lastMessageImages })
            : pooled.session.prompt(lastMessage.content);

        promptPromise
          .then(() => {
            log("prompt", "agent.prompt() resolved");
          })
          .catch((err) => {
            console.error("agent.prompt() failed:", err);
            // Unsubscribe to prevent listener leak
            unsubscribe();
            // Clear in-progress flag so the user can retry
            prisma.chatSession
              .update({ where: { id: sessionId }, data: { processingSince: null } })
              .catch((updateErr) => {
                console.error("Failed to clear processingSince on error:", updateErr);
              });
            unregisterActiveSession(authResult.user.id, sessionId).catch(console.error);
            sendEvent(controller, "error", { message: err.message });
            sendEvent(controller, "done", {});
            closeController(controller);
          });
      } else if (!shouldPrompt && pooled.lastPromptedMessageId) {
        // Reconnect case — agent already processed this message.
        // Subscribe to events is already active above (catches in-progress turns).
        // If the agent has already finished, agent_end was emitted to the previous
        // client — this new subscription won't see it, so emit done immediately.
        if (!pooled.session.isStreaming) {
          log("prompt_guard", "agent already finished (isStreaming=false), emitting done");
          unsubscribe();
          sendEvent(controller, "done", {});
          closeController(controller);
        } else {
          log("prompt_guard", "agent still streaming (isStreaming=true), waiting for events");
        }
      }

      // Handle client disconnect — stop sending SSE events but let the agent
      // finish processing so messages are still saved to the database.
      // When the user navigates back, loadMessages() picks up the saved response.
      request.signal.addEventListener("abort", () => {
        log("client", "disconnect detected, unsubscribing (agent continues)");
        clientDisconnected = true;
        unsubscribe();
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

/**
 * Handle reconnection via Redis pub/sub (agent not in pool or as fallback).
 */
function handleReconnectFromRedis(sessionId: string, request: NextRequest): Response {
  const encoder = new TextEncoder();

  const sse = (event: string, data: unknown): string => {
    const json = JSON.stringify(data);
    const escaped = json.replace(/\n/g, "\\n").replace(/\r/g, "\\r");
    return `event: ${event}\ndata: ${escaped}\n\n`;
  };

  // Async iterator — proper pattern for indefinite async SSE streams.
  // Yields buffered events first, then live pub/sub events.
  // Falls back to DB polling if pub/sub delivers nothing.
  async function* reconnectEvents() {
    let subscriber: ReturnType<typeof createRedisClient> | null = null;
    let done = false;
    let aborted = false;

    const cleanup = () => {
      aborted = true;
      if (subscriber) {
        try {
          subscriber.unsubscribe(`${STREAM_CHANNEL_PREFIX}${sessionId}`);
        } catch (err) {
          console.error("Error unsubscribing from Redis (may already be closed):", err);
        }
        subscriber.quit().catch((err) => {
          console.error("Failed to close Redis subscriber:", err);
        });
        subscriber = null;
      }
    };

    request.signal.addEventListener("abort", cleanup, { once: true });

    try {
      // Send buffered events first (catch up on anything we missed)
      const buffered = await getBufferedEvents(sessionId);
      for (const raw of buffered) {
        if (aborted) break;
        try {
          const { event, data } = JSON.parse(raw);
          yield encoder.encode(sse(event, data));
          if (event === "done" || event === "error") {
            done = true;
          }
        } catch (err) {
          console.error("Malformed buffered event:", err);
        }
      }
      if (done || aborted) {
        cleanup();
        return;
      }

      // Subscribe to live pub/sub events
      subscriber = createRedisClient();
      await subscriber.subscribe(`${STREAM_CHANNEL_PREFIX}${sessionId}`);

      // Wait for pub/sub messages with timeout.
      // If no message arrives within 30s, fall back to DB polling.
      while (!done && !aborted) {
        const message = await new Promise<{ event: string; data: unknown } | null>((resolve) => {
          let resolved = false;
          const handler = (_channel: string, raw: string) => {
            if (resolved) return;
            resolved = true;
            try {
              resolve(JSON.parse(raw));
            } catch (err) {
              console.error("Malformed pub/sub message:", err);
              resolve(null);
            }
          };
          subscriber!.on("message", handler);

          const timer = setTimeout(() => {
            if (resolved) return;
            resolved = true;
            subscriber?.off("message", handler);
            resolve(null);
          }, 30000);

          // If resolved by handler, clear the timeout
          const originalResolve = resolve;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (resolve as any) = (val: Parameters<typeof originalResolve>[0]) => {
            if (!resolved) {
              resolved = true;
              clearTimeout(timer);
              subscriber?.off("message", handler);
              originalResolve(val);
            }
          };
        });

        if (aborted) break;

        if (message) {
          // Pub/sub delivered an event — forward it
          yield encoder.encode(sse(message.event, message.data));
          if (message.event === "done" || message.event === "error") {
            done = true;
          }
          continue;
        }

        // No pub/sub event within 30s — poll DB for completed messages
        const session = await prisma.chatSession.findUnique({
          where: { id: sessionId },
          select: { processingSince: true },
        });
        if (!session?.processingSince) {
          // Agent finished — load latest assistant messages from DB
          const messages = await prisma.chatMessage.findMany({
            where: { sessionId, role: "assistant" },
            orderBy: { createdAt: "asc" },
            take: 10,
          });
          if (messages.length > 0) {
            yield encoder.encode(
              sse("resume", {
                messages: messages.map((m) => ({
                  id: m.id,
                  content: m.content,
                  thinking: m.thinking,
                  toolCalls: m.toolCalls ? JSON.parse(m.toolCalls) : undefined,
                })),
              }),
            );
          }
          yield encoder.encode(sse("done", {}));
          done = true;
        }
      }

      cleanup();
    } catch (err) {
      console.error("Reconnection error:", err);
      cleanup();
      yield encoder.encode(sse("error", { message: "Reconnection failed" }));
    }
  }

  const iterator = reconnectEvents();
  const reconnectStream = new ReadableStream({
    async pull(controller) {
      const result = await iterator.next();
      if (result.done) {
        controller.close();
        return;
      }
      controller.enqueue(result.value);
    },
  });

  return new Response(reconnectStream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

async function saveAssistantMessage(
  sessionId: string,
  content: string,
  thinking?: string,
  toolCalls?: Array<{
    id: string;
    name: string;
    args: Record<string, unknown>;
    result: string | undefined;
    isError: boolean | undefined;
  }>,
  parentMessageId?: string | null,
): Promise<{ id: string }> {
  return prisma.chatMessage.create({
    data: {
      sessionId,
      role: "assistant",
      content,
      thinking: thinking || null,
      toolCalls: toolCalls && toolCalls.length > 0 ? JSON.stringify(toolCalls) : null,
      parentMessageId: parentMessageId || null,
    },
  });
}
