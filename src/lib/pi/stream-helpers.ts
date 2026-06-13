import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { createRedisClient, getRedis } from "@/lib/redis";
import { formatSseEvent } from "@/lib/pi/stream-logic";

const STREAM_CHANNEL_PREFIX = "chat:stream:";
const BUFFER_KEY_PREFIX = "chat:stream:buf:";
const BUFFER_TTL_SECONDS = 60;
const BUFFER_MAX_SIZE = 200;

/** Publish an SSE-formatted event to Redis for other clients to receive. */
export async function publishStreamEvent(
  sessionId: string,
  event: string,
  data: unknown,
): Promise<void> {
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
