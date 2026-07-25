import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { createRedisClient, getRedis } from "@/lib/redis";
import { formatSseEvent } from "@/lib/pi/stream-logic";

const STREAM_CHANNEL_PREFIX = "chat:stream:";
const BUFFER_KEY_PREFIX = "chat:stream:buf:";
const BUFFER_TTL_SECONDS = 60;
const BUFFER_MAX_SIZE = 200;

/**
 * Centralized SSE event dispatcher.
 *
 * Always publishes to Redis (for reconnecting clients) and enqueues to the
 * primary SSE controller (for the active connection). The controller is wired
 * lazily via .wire() so the dispatcher can be created before the stream starts
 * (e.g., for approval callbacks captured in tool wrappers).
 *
 * This is the single path for emitting stream events — there is no separate
 * "publish to Redis" or "enqueue to controller" API. This prevents bugs where
 * an event is sent to one path but not the other.
 */
export class StreamDispatcher {
  private controller: ReadableStreamDefaultController | null = null;
  private encoder: TextEncoder | null = null;
  private closed = false;

  constructor(private readonly sessionId: string) {}

  /**
   * Wire the SSE controller and encoder.
   * Called once inside ReadableStream's start() callback.
   */
  wire(controller: ReadableStreamDefaultController, encoder: TextEncoder): void {
    this.controller = controller;
    this.encoder = encoder;
    this.closed = false;
  }

  /**
   * Emit an SSE event. Always publishes to Redis AND enqueues to the controller
   * (if wired and not closed). This is the only public method for sending events.
   */
  emit(event: string, data: unknown): void {
    const payload = this.encoder ? this.encoder.encode(formatSseEvent(event, data)) : null;

    // Enqueue to primary SSE connection (if wired and alive)
    if (payload && this.controller && !this.closed) {
      try {
        this.controller.enqueue(payload);
      } catch (err) {
        console.error("Failed to enqueue SSE event:", err);
      }
    }

    // Publish to Redis for reconnecting clients (fire-and-forget)
    publishToRedis(this.sessionId, event, data).catch(console.error);
  }

  /** Mark the dispatcher as closed (client disconnected or stream ended). */
  close(): void {
    this.closed = true;
  }
}

/**
 * Publish an SSE-formatted event to Redis for reconnecting clients.
 * Internal — use StreamDispatcher.emit() instead of calling this directly.
 */
async function publishToRedis(sessionId: string, event: string, data: unknown): Promise<void> {
  try {
    const redis = getRedis();
    const payload = JSON.stringify({ event, data });
    const channel = `${STREAM_CHANNEL_PREFIX}${sessionId}`;
    await redis.publish(channel, payload);

    const bufKey = `${BUFFER_KEY_PREFIX}${sessionId}`;
    await redis.lpush(bufKey, payload);
    await redis.ltrim(bufKey, 0, BUFFER_MAX_SIZE - 1);
    await redis.expire(bufKey, BUFFER_TTL_SECONDS);
  } catch (err) {
    console.error("Redis publish error:", err);
  }
}

/**
 * @deprecated Use StreamDispatcher.emit() instead.
 * Kept only for the reconnect path which has no controller to wire.
 */
export async function publishStreamEvent(
  sessionId: string,
  event: string,
  data: unknown,
): Promise<void> {
  await publishToRedis(sessionId, event, data);
}

/** Get buffered events for a session (oldest first). */
export async function getBufferedEvents(sessionId: string): Promise<string[]> {
  try {
    const redis = getRedis();
    const bufKey = `${BUFFER_KEY_PREFIX}${sessionId}`;
    const events = await redis.lrange(bufKey, 0, -1);
    return events.reverse();
  } catch (err) {
    console.error("Redis buffer read error:", err);
    return [];
  }
}

/**
 * Handle reconnection via Redis pub/sub (agent not in pool or as fallback).
 */
export function handleReconnectFromRedis(sessionId: string, request: NextRequest): Response {
  const encoder = new TextEncoder();

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
      // Check for in-progress tool (persisted to DB on tool_execution_start).
      // Emit immediately so the reconnecting client knows what's running.
      const sessionForTool = await prisma.chatSession.findUnique({
        where: { id: sessionId },
        select: {
          activeToolCallId: true,
          activeToolName: true,
          activeToolArgs: true,
          activeToolStartedAt: true,
        },
      });
      if (sessionForTool?.activeToolName) {
        yield encoder.encode(
          formatSseEvent("tool_resume", {
            toolCallId:
              sessionForTool.activeToolCallId ?? `resume-${sessionForTool.activeToolName}`,
            toolName: sessionForTool.activeToolName,
            args: sessionForTool.activeToolArgs,
            startedAt: sessionForTool.activeToolStartedAt?.toISOString() ?? null,
          }),
        );
      }

      const buffered = await getBufferedEvents(sessionId);
      for (const raw of buffered) {
        if (aborted) break;
        try {
          const { event, data } = JSON.parse(raw);
          yield encoder.encode(formatSseEvent(event, data));
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

      subscriber = createRedisClient();
      await subscriber.subscribe(`${STREAM_CHANNEL_PREFIX}${sessionId}`);

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
          yield encoder.encode(formatSseEvent(message.event, message.data));
          if (message.event === "done" || message.event === "error") {
            done = true;
          }
          continue;
        }

        const session = await prisma.chatSession.findUnique({
          where: { id: sessionId },
          select: { processingSince: true },
        });
        if (!session?.processingSince) {
          const messages = await prisma.chatMessage.findMany({
            where: { sessionId, role: "assistant" },
            orderBy: { createdAt: "asc" },
            take: 10,
          });
          if (messages.length > 0) {
            yield encoder.encode(
              formatSseEvent("resume", {
                messages: messages.map((m) => ({
                  id: m.id,
                  content: m.content,
                  thinking: m.thinking,
                  toolCalls: m.toolCalls ? JSON.parse(m.toolCalls) : undefined,
                })),
              }),
            );
          }
          yield encoder.encode(formatSseEvent("done", {}));
          done = true;
        }
      }

      cleanup();
    } catch (err) {
      console.error("Reconnection error:", err);
      cleanup();
      yield encoder.encode(formatSseEvent("error", { message: "Reconnection failed" }));
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

/**
 * Clear the processingSince flag on a chat session.
 *
 * Centralized so all callers (agent_end, compaction, errors) use the same
 * path — prevents bugs where one caller forgets to clear the flag.
 */
export async function clearProcessingSince(sessionId: string): Promise<void> {
  await prisma.chatSession.update({
    where: { id: sessionId },
    data: { processingSince: null },
  });
}

export async function saveAssistantMessage(
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
