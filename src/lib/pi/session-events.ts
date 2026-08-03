/**
 * Cross-process session event bus for chat streaming.
 *
 * Chat sessions can be driven from multiple processes (the Next.js web
 * process and the BullMQ worker process that runs Telegram agents). To let
 * every connected SSE client observe a live generation regardless of which
 * process runs it, all stream events flow through Redis:
 *
 *   1. The publisher (session event tracker / approval gate) buffers the
 *      event in Redis (assigning a global, monotonic event ID) and publishes
 *      it to the session's pub/sub channel.
 *   2. Each process keeps one shared Redis subscriber connection. Channels
 *      are subscribed on demand (refcounted per session) and events are
 *      fanned out to local listeners (the SseDispatcher).
 *   3. The dispatcher replays buffered events to new/reconnecting clients
 *      and dedupes the overlap with live pub/sub delivery by event ID.
 *
 * Redis pub/sub is best-effort — a dropped subscriber misses events — but
 * the buffer is the recovery mechanism: any missed event is replayed on the
 * next (re)connect via Last-Event-ID.
 */

import type { Redis } from "ioredis";
import { createRedisClient, getRedis } from "@/lib/redis";
import { bufferEvent, clearBuffer, type BufferedEvent } from "./sse-buffer";

const CHANNEL_PREFIX = "chat:events:";
const channelFor = (sessionId: string) => `${CHANNEL_PREFIX}${sessionId}`;

/** A stream event as it travels through the bus (buffered + published). */
export type SessionStreamEvent = BufferedEvent;

/** Per-session subscription state within this process. */
interface SessionSubscription {
  listeners: Set<(evt: SessionStreamEvent) => void>;
  /** True once the Redis SUBSCRIBE command has settled (success or failure). */
  subscribed: boolean;
  /** Resolves when the Redis SUBSCRIBE settles. */
  pending: Promise<void> | null;
  resolvePending: () => void;
}

/** sessionId → local listeners (refcounted). */
const subscriptions = new Map<string, SessionSubscription>();

/** Shared subscriber connection for this process (lazy, one per process). */
let subscriber: Redis | null = null;

function ensureSubscriber(): Redis {
  if (!subscriber) {
    subscriber = createRedisClient();
    subscriber.on("message", (_channel, message) => {
      let evt: SessionStreamEvent;
      try {
        evt = JSON.parse(message) as SessionStreamEvent;
      } catch (err) {
        console.error("Malformed session event on bus:", err, message?.slice(0, 200));
        return;
      }
      const sessionId = _channel.slice(CHANNEL_PREFIX.length);
      const sub = subscriptions.get(sessionId);
      if (!sub) return;
      for (const listener of [...sub.listeners]) {
        try {
          listener(evt);
        } catch (err) {
          console.error(`Session event listener failed for ${sessionId}:`, err);
        }
      }
    });
    subscriber.on("error", (err) => {
      console.error("Session events subscriber error:", err);
    });
  }
  return subscriber;
}

/**
 * Buffer an event in Redis and publish it to the session's channel.
 *
 * Returns the globally monotonic event ID assigned by the buffer. The
 * publishing process receives its own events via the subscriber connection
 * (separate from the publisher connection), so local observers get the same
 * single code path as observers in other processes.
 */
export async function publishSessionEvent(
  sessionId: string,
  event: string,
  data: unknown,
): Promise<number> {
  const id = await bufferEvent(sessionId, event, data);
  const redis = getRedis();
  await redis.publish(channelFor(sessionId), JSON.stringify({ id, event, data })).catch((err) => {
    console.error(`Failed to publish session event "${event}" for ${sessionId}:`, err);
  });
  return id;
}

/**
 * Subscribe to a session's live events.
 *
 * Resolves once the Redis SUBSCRIBE has settled, so callers can safely read
 * the buffer afterwards without missing events published in between (the
 * overlap is deduped by event ID downstream).
 *
 * Returns an unsubscribe function. Subscriptions are refcounted per session
 * — the shared subscriber connection drops the channel when the last local
 * listener unsubscribes.
 */
export async function subscribeSessionEvents(
  sessionId: string,
  listener: (evt: SessionStreamEvent) => void,
): Promise<() => void> {
  let sub = subscriptions.get(sessionId);
  if (!sub) {
    sub = { listeners: new Set(), subscribed: false, pending: null, resolvePending: () => {} };
    subscriptions.set(sessionId, sub);
  }
  sub.listeners.add(listener);

  if (!sub.subscribed) {
    if (!sub.pending) {
      sub.pending = new Promise<void>((resolve) => {
        sub!.resolvePending = resolve;
      });
      ensureSubscriber()
        .subscribe(channelFor(sessionId))
        .then(() => {
          sub!.subscribed = true;
          sub!.resolvePending();
        })
        .catch((err) => {
          console.error(`Failed to subscribe to session events for ${sessionId}:`, err);
          // Don't retry-loop: mark subscribed so callers proceed and rely on
          // buffer replay; ioredis re-subscribes automatically on reconnect.
          sub!.subscribed = true;
          sub!.resolvePending();
        });
    }
    await sub.pending;
  }

  return () => {
    const current = subscriptions.get(sessionId);
    if (!current) return;
    current.listeners.delete(listener);
    if (current.listeners.size === 0) {
      subscriptions.delete(sessionId);
      ensureSubscriber()
        .unsubscribe(channelFor(sessionId))
        .catch((err) => {
          console.error(`Failed to unsubscribe from session events for ${sessionId}:`, err);
        });
    }
  };
}

/**
 * Clear a session's event buffer (called at the start of a new generation).
 *
 * Removes stale events from previous runs so fresh connects don't replay
 * them. The event-ID counter survives (see clearBuffer), keeping
 * Last-Event-ID reconnects working across generations.
 */
export async function resetSessionEvents(sessionId: string): Promise<void> {
  try {
    await clearBuffer(sessionId);
  } catch (err) {
    console.error(`Failed to reset session events for ${sessionId}:`, err);
  }
}
