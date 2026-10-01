/**
 * Redis-backed SSE event buffer with monotonically increasing event IDs.
 *
 * Uses Redis sorted sets (ZADD) keyed by event ID for efficient range queries.
 * Supports the SSE spec's Last-Event-ID reconnection mechanism.
 */

import { getRedis } from "@/lib/redis";

const BUFFER_KEY_PREFIX = "chat:sse:buf:";
const COUNTER_KEY_SUFFIX = ":counter";
// 30 minutes — replays must survive long tool executions and reconnect
// gaps (matches the agent pool's idle-eviction window).
const BUFFER_TTL_SECONDS = 30 * 60;
// The event-ID counter must outlive ANY idle stretch inside a generation: a
// tool call can legitimately run for many minutes without emitting a single
// event. If the counter expired mid-generation, IDs would restart at 1 and
// clients holding a higher Last-Event-ID would silently skip every new event
// (see sse-dispatcher) — the stream looks dead while Pi is still working.
// 24h is far beyond any realistic tool run, and the TTL is refreshed on every
// event so abandoned sessions still clean themselves up.
const COUNTER_TTL_SECONDS = 24 * 60 * 60;
const BUFFER_MAX_SIZE = 500; // enough for tool-heavy workloads

/**
 * Shape of a buffered event stored in Redis.
 */
export interface BufferedEvent {
  id: number;
  event: string;
  data: unknown;
}

/**
 * Generate the next event ID for a session.
 * Uses Redis INCR for atomic monotonically increasing IDs across process restarts.
 */
export async function nextEventId(sessionId: string): Promise<number> {
  const redis = getRedis();
  const counterKey = `${BUFFER_KEY_PREFIX}${sessionId}${COUNTER_KEY_SUFFIX}`;
  const id = await redis.incr(counterKey);
  // Long TTL so IDs stay monotonic across the whole generation — see the
  // COUNTER_TTL_SECONDS comment above.
  await redis.expire(counterKey, COUNTER_TTL_SECONDS);
  return id;
}

/**
 * Store an SSE event in the buffer.
 * Returns the event ID assigned to this event.
 */
export async function bufferEvent(
  sessionId: string,
  event: string,
  data: unknown,
): Promise<number> {
  const redis = getRedis();
  const id = await nextEventId(sessionId);
  const bufKey = `${BUFFER_KEY_PREFIX}${sessionId}`;
  const payload = JSON.stringify({ id, event, data });

  // Sorted set: score = event ID (monotonic), value = JSON payload
  await redis.zadd(bufKey, id, payload);

  // Trim to max size (remove oldest events)
  await redis.zremrangebyrank(bufKey, 0, -(BUFFER_MAX_SIZE + 1));
  await redis.expire(bufKey, BUFFER_TTL_SECONDS);

  return id;
}

/**
 * Event names that end a run — a client settles on them.
 */
const TERMINAL_EVENT_NAMES = new Set(["done", "error"]);

/** Whether a buffered event ends a run (its clients settle on it). */
export function isTerminalBufferedEvent(event: BufferedEvent): boolean {
  return TERMINAL_EVENT_NAMES.has(event.event);
}

/**
 * Get all buffered events with ID greater than lastEventId.
 * Returns events in order (oldest first).
 */
export async function getBufferedEvents(
  sessionId: string,
  lastEventId: number,
): Promise<BufferedEvent[]> {
  try {
    const redis = getRedis();
    const bufKey = `${BUFFER_KEY_PREFIX}${sessionId}`;

    // Get all entries with score > lastEventId (values only, no scores needed)
    const rawEvents = await redis.zrangebyscore(bufKey, lastEventId + 1, "+inf");

    // zrangebyscore returns [value1, value2, ...] in score order (ascending = oldest first)
    const results: BufferedEvent[] = [];
    for (const raw of rawEvents) {
      if (typeof raw === "string") {
        try {
          results.push(JSON.parse(raw) as BufferedEvent);
        } catch {
          // Skip malformed entries
        }
      }
    }

    return results;
  } catch (err) {
    console.error("Failed to read SSE buffer:", err);
    return [];
  }
}

/**
 * Get the most recently buffered event, or null when nothing is buffered.
 *
 * Used as a cheap liveness/state probe by recovery paths (the stream route's
 * stale-generation supervisor) that only care whether the newest event ended a
 * run — not about the backlog behind it.
 */
export async function getLastBufferedEvent(sessionId: string): Promise<BufferedEvent | null> {
  try {
    const redis = getRedis();
    const raw = await redis.zrange(`${BUFFER_KEY_PREFIX}${sessionId}`, -1, "-1");
    if (!raw.length) return null;
    const value = raw[0];
    if (typeof value !== "string") return null;
    return JSON.parse(value) as BufferedEvent;
  } catch (err) {
    console.error("Failed to read the last SSE buffer event:", err);
    return null;
  }
}

/**
 * Clear the buffered events for a session (called when a new generation starts).
 *
 * The event-ID counter is deliberately NOT reset. Event IDs must stay
 * monotonically increasing across generations so that clients reconnecting
 * with a `Last-Event-ID` from a previous generation keep receiving new events
 * (new events always have higher IDs than anything the client has seen).
 */
export async function clearBuffer(sessionId: string): Promise<void> {
  try {
    const redis = getRedis();
    const bufKey = `${BUFFER_KEY_PREFIX}${sessionId}`;
    await redis.del(bufKey);
  } catch (err) {
    console.error("Failed to clear SSE buffer:", err);
  }
}
