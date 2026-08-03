/**
 * Redis-backed SSE event buffer with monotonically increasing event IDs.
 *
 * Uses Redis sorted sets (ZADD) keyed by event ID for efficient range queries.
 * Supports the SSE spec's Last-Event-ID reconnection mechanism.
 */

import { getRedis } from "@/lib/redis";

const BUFFER_KEY_PREFIX = "chat:sse:buf:";
const COUNTER_KEY_SUFFIX = ":counter";
const BUFFER_TTL_SECONDS = 300; // 5 minutes — covers long tool executions
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
  await redis.expire(counterKey, BUFFER_TTL_SECONDS);
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
 * Get the latest event ID for a session (highest score in the sorted set).
 * Returns -1 if no events are buffered.
 */
export async function getLatestEventId(sessionId: string): Promise<number> {
  try {
    const redis = getRedis();
    const bufKey = `${BUFFER_KEY_PREFIX}${sessionId}`;

    // Get the highest score (latest event ID)
    const result = await redis.zrevrange(bufKey, 0, 0, "WITHSCORES");
    if (result.length === 0) return -1;

    const value = result[0];
    if (typeof value === "string") {
      const parsed = JSON.parse(value) as BufferedEvent;
      return parsed.id;
    }
    return -1;
  } catch (err) {
    console.error("Failed to get latest event ID:", err);
    return -1;
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

/**
 * Check if there are any buffered events for a session.
 */
export async function hasBufferedEvents(sessionId: string): Promise<boolean> {
  try {
    const redis = getRedis();
    const bufKey = `${BUFFER_KEY_PREFIX}${sessionId}`;
    const count = await redis.zcard(bufKey);
    return count > 0;
  } catch (err) {
    console.error("Failed to check buffer:", err);
    return false;
  }
}
