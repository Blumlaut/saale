import { NextRequest } from "next/server";
import { requireSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import {
  createRedisClient,
  getRedis,
  registerActiveSession,
  unregisterActiveSession,
} from "@/lib/redis";
import { createPiSession, type ToolConfig } from "@/lib/pi/session";
import { resolveModelForPurpose } from "@/lib/pi/model-resolution";
import {
  normalizeToolResult,
  buildHistoryMessages,
  type StoredMessage,
  type ImageContent,
} from "@/lib/pi/message-replay";
import { readImageAsBase64 } from "@/lib/image-attachment";

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

/** In-memory cache of running Pi sessions (for explicit cancellation via stop endpoint within the same process). */
export const activeSessions = new Map<string, { agent: { abort: () => void } }>();

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
 * Emits: token (cumulative text for current turn), thinking (cumulative thinking for current turn),
 *         tool_start, tool_end, turn_end (completed turn data), done
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

  // Get all messages for context (with attachments for image support)
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

  // Resolve tool config to know which tool categories are enabled
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

  // If another request is already processing this session and the client explicitly
  // requests reconnection (?reconnect=1), subscribe to Redis pub/sub and forward events.
  // Without ?reconnect=1 this is the primary stream — always process normally even if
  // processingSince is set (the POST endpoint sets it before returning the stream URL).
  const url = new URL(request.url);
  const isReconnect = url.searchParams.get("reconnect") === "1";

  if (isReconnect && chatSession.processingSince) {
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

  // Create Pi session with custom tools (filtered by toolConfig)
  const { session: piSession } = await createPiSession({
    userId: authResult.user.id,
    customTools: [],
    ...(chatSession.toolConfig && { toolConfig: resolvedToolConfig }),
    modelProvider,
    modelName,
    thinkingLevel: chatSession.thinkingLevel || "off",
  });

  // Register session for explicit cancellation (stop endpoint)
  // In-memory map: same-process abort
  activeSessions.set(sessionId, { agent: piSession.agent });
  // Redis: cross-instance tracking (used by stop endpoint to detect stale state)
  await registerActiveSession(authResult.user.id, sessionId);

  // Capture resolved model for consistent history reconstruction.
  // Using the actual model's api/provider/id ensures transformMessages treats
  // replayed messages as same-model (isSameModel=true), preserving thinking
  // blocks, tool signatures, etc. — critical for cache hits.
  const model = piSession.model;

  // Set up system prompt — use user-defined prompt if set, otherwise fall back to default
  const defaultSystemPrompt =
    "You are a helpful AI assistant. Be concise, direct, and write natural responses.";
  const basePrompt =
    userSettings?.agentSystemPrompt && userSettings.agentSystemPrompt.trim()
      ? userSettings.agentSystemPrompt
      : defaultSystemPrompt;

  // Conditionally append memory instruction only when memory tools are enabled
  const memoryInstruction =
    resolvedToolConfig.memory !== false
      ? "\n\nYou have a persistent memory system. If the user references something you don't know about, use `memory_search` to look it up before answering."
      : "";

  piSession.agent.state.systemPrompt = basePrompt + memoryInstruction;

  // Reconstruct conversation history from DB messages.
  // buildHistoryMessages ensures byte-identical output to the live agent:
  // - toolCallId (not toolUseId) for correct provider adapter mapping
  // - resolved model metadata for same-model detection in transformMessages
  // - canonical content block order: thinking → text → toolCall
  // - toolResult text extracted (not double-encoded)
  // - image attachments re-read from disk (deterministic WebP → base64)
  const storedMessages: StoredMessage[] = messages.map((m) => ({
    role: m.role,
    content: m.content,
    thinking: m.thinking,
    toolCalls: m.toolCalls,
    attachments: m.attachments.map((a) => ({
      storagePath: a.storagePath,
      mimeType: a.mimeType,
    })),
  }));

  // Pre-load images for all user messages in history (not the last one — that's the current prompt).
  // This ensures byte-identical base64 data across turns → LLM cache hits.
  // Map from history index (0-based, excludes last message) to ImageContent[].
  const imageCache = new Map<number, ImageContent[]>();
  const historyMessagesSlice = storedMessages.slice(0, -1);
  for (let i = 0; i < historyMessagesSlice.length; i++) {
    const m = historyMessagesSlice[i]!;
    if (m.role === "user" && m.attachments && m.attachments.length > 0) {
      const images: ImageContent[] = [];
      for (const att of m.attachments) {
        try {
          const { data, mimeType } = await readImageAsBase64(authResult.user.id, att.storagePath);
          images.push({ type: "image" as const, data, mimeType });
        } catch (err) {
          console.error(`Failed to load image for history message ${i}:`, err);
        }
      }
      if (images.length > 0) {
        imageCache.set(i, images);
      }
    }
  }

  const historyMessages = buildHistoryMessages(storedMessages, {
    api: model?.api,
    provider: model?.provider,
    id: model?.id,
    imageCache,
  });

  // Pre-load images for the current (last) user message.
  // Must be done outside the stream's start() callback (which is not async).
  const lastMessageImages: ImageContent[] = [];
  const lastMessage = messages[messages.length - 1];
  if (lastMessage && lastMessage.role === "user" && lastMessage.attachments.length > 0) {
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
    if (clientDisconnected) return;
    const json = JSON.stringify(data);
    // Replace literal newlines with \n to prevent SSE event termination
    const escaped = json.replace(/\n/g, "\\n").replace(/\r/g, "\\r");
    controller.enqueue(encoder.encode(`event: ${event}\ndata: ${escaped}\n\n`));

    // Publish to Redis for reconnecting clients (fire-and-forget)
    publishStreamEvent(sessionId, event, data).catch(console.error);
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
      // Inject conversation history into the agent state
      if (historyMessages.length > 0) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- AgentMessage type requires full AssistantMessage fields (api/provider/model/usage), but convertToLlm handles simple {role, content} objects at runtime
        piSession.agent.state.messages = historyMessages as any;
      }

      // Subscribe to agent events
      piSession.subscribe((event) => {
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
            // Uses the same logic as buildHistoryMessages to ensure the stored
            // result matches what would be replayed — critical for cache hits.
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
            // Collect tool calls for this turn from the message content
            // event.message is AgentMessage which may not have .content (e.g., BashExecutionMessage)
            // Narrow to messages that have content
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

          case "agent_end": {
            // Get final assistant message(s)
            // Cast to access content property (AgentMessage is a union that includes non-content types)
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

            // Clean up session cache
            activeSessions.delete(sessionId);
            unregisterActiveSession(authResult.user.id, sessionId).catch(console.error);

            sendEvent(controller, "done", {});

            if (!clientDisconnected) {
              controller.close();
            }
            break;
          }
        }
      });

      // Send the user message to the agent
      // Use agent.prompt() directly to bypass AgentSession preflight logic
      // which resets systemPrompt back to the Pi base prompt on every turn
      if (lastMessage && lastMessage.role === "user") {
        const promptPromise =
          lastMessageImages.length > 0
            ? piSession.agent.prompt(lastMessage.content, lastMessageImages)
            : piSession.agent.prompt(lastMessage.content);
        promptPromise.catch((err) => {
          console.error("agent.prompt() failed:", err);
          // Clear in-progress flag so the user can retry
          prisma.chatSession
            .update({ where: { id: sessionId }, data: { processingSince: null } })
            .catch((updateErr) => {
              console.error("Failed to clear processingSince on error:", updateErr);
            });
          activeSessions.delete(sessionId);
          unregisterActiveSession(authResult.user.id, sessionId).catch(console.error);
          sendEvent(controller, "error", { message: err.message });
          sendEvent(controller, "done", {});
          if (!clientDisconnected) {
            controller.close();
          }
        });
      }

      // Handle client disconnect — stop sending SSE events but let the agent
      // finish processing so messages are still saved to the database.
      // When the user navigates back, loadMessages() picks up the saved response.
      request.signal.addEventListener("abort", () => {
        clientDisconnected = true;
        controller.close();
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
