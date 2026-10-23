/**
 * Redis-backed SSE event buffer with monotonically increasing event IDs.
 *
 * Uses Redis sorted sets (ZADD) keyed by event ID for efficient range queries.
 * Supports the SSE spec's Last-Event-ID reconnection mechanism.
 */

import { getRedis } from "@/lib/redis";

const BUFFER_KEY_PREFIX = "chat:sse:buf:";
const COUNTER_KEY_SUFFIX = ":counter";
// 30 minutes. replays must survive long tool executions and reconnect
// gaps (matches the agent pool's idle-eviction window).
const BUFFER_TTL_SECONDS = 30 * 60;
// The event-ID counter must outlive ANY idle stretch inside a generation: a
// tool call can legitimately run for many minutes without emitting a single
// event. If the counter expired mid-generation, IDs would restart at 1 and
// clients holding a higher Last-Event-ID would silently skip every new event
// (see sse-dispatcher). the stream looks dead while Pi is still working.
// 24h is far beyond any realistic tool run, and the TTL is refreshed on every
// event so abandoned sessions still clean themselves up.
const COUNTER_TTL_SECONDS = 24 * 60 * 60;
const BUFFER_MAX_SIZE = 500; // enough for tool-heavy workloads

/**
 * Events whose payload is the turn's CUMULATIVE text (the full text so far,
 * re-sent with every token). Live clients receive every one of them via
 * pub/sub; the buffer exists only for reconnect replay, and a replaying
 * client applies cumulative text, so one buffered snapshot per second is
 * enough to land it within a second of where the live stream was.
 *
 * Without this, a long answer buffers hundreds of ever-larger copies of the
 * same text. O(n²) bytes in Redis and in every JSON.stringify per turn.
 */
const CUMULATIVE_EVENTS = new Set(["token", "thinking"]);
const CUMULATIVE_BUFFER_INTERVAL_MS = 1000;

/** Last time a cumulative snapshot was buffered, per session (throttle state). */
const lastCumulativeBufferedAt = new Map<string, number>();
/** Bound the throttle map: sessions are never explicitly removed from it. */
const MAX_THROTTLE_TRACKED_SESSIONS = 1000;

function shouldSkipCumulativeSnapshot(sessionId: string, event: string): boolean {
  if (!CUMULATIVE_EVENTS.has(event)) return false;

  const now = Date.now();
  const last = lastCumulativeBufferedAt.get(sessionId);
  if (last !== undefined && now - last < CUMULATIVE_BUFFER_INTERVAL_MS) return true;

  // Re-insert rather than overwrite so the map's insertion order is recency
  // order, which makes the eviction below the least recently buffered session.
  // Both operations are O(1): the hot path must not scan the map per token.
  // Evicting a session only costs it one unthrottled snapshot, never
  // correctness: `turn_end` always carries the full text.
  lastCumulativeBufferedAt.delete(sessionId);
  lastCumulativeBufferedAt.set(sessionId, now);
  if (lastCumulativeBufferedAt.size > MAX_THROTTLE_TRACKED_SESSIONS) {
    const oldest = lastCumulativeBufferedAt.keys().next();
    if (!oldest.done) lastCumulativeBufferedAt.delete(oldest.value);
  }
  return false;
}

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
  // Long TTL so IDs stay monotonic across the whole generation. see the
  // COUNTER_TTL_SECONDS comment above. One round trip instead of two: the
  // counter refresh is part of the same transaction as the increment.
  const results = await redis
    .multi()
    .incr(counterKey)
    .expire(counterKey, COUNTER_TTL_SECONDS)
    .exec();
  const id = results?.[0]?.[1];
  if (typeof id !== "number") {
    throw new Error(`Unexpected Redis response for INCR ${counterKey}`);
  }
  return id;
}

/**
 * Store an SSE event in the buffer.
 * Returns the event ID assigned to this event.
 *
 * Cumulative text snapshots are buffered at most once per second (see
 * CUMULATIVE_EVENTS): they still get an ID and still go to every live client,
 * only the replay copy is throttled.
 *
 * The write is two MULTI transactions (the ID must exist before the sorted
 * set entry is scored with it): 2 Redis round trips per buffered event
 * instead of one per command.
 */
export async function bufferEvent(
  sessionId: string,
  event: string,
  data: unknown,
): Promise<number> {
  const redis = getRedis();
  const id = await nextEventId(sessionId);

  if (shouldSkipCumulativeSnapshot(sessionId, event)) return id;

  const bufKey = `${BUFFER_KEY_PREFIX}${sessionId}`;
  const payload = JSON.stringify({ id, event, data });

  // Sorted set: score = event ID (monotonic), value = JSON payload.
  // Trim to max size (remove oldest events) and refresh the TTL in the same
  // transaction.
  await redis
    .multi()
    .zadd(bufKey, id, payload)
    .zremrangebyrank(bufKey, 0, -(BUFFER_MAX_SIZE + 1))
    .expire(bufKey, BUFFER_TTL_SECONDS)
    .exec();

  return id;
}

/**
 * Event names that end a run. a client settles on them.
 */
const TERMINAL_EVENT_NAMES = new Set(["done", "error"]);

/** Whether a buffered event ends a run (its clients settle on it). */
export function isTerminalBufferedEvent(event: BufferedEvent): boolean {
  return TERMINAL_EVENT_NAMES.has(event.event);
}

/**
 * The part of a buffer that belongs to the run still in flight.
 *
 * Everything up to and including the last terminal event is a run that already
 * ended, and replaying it is what made a freshly opened chat flicker: the
 * client rebuilt a reply that was already on screen from the DB, token by
 * token and card by card, and then dropped the rebuild on the `done` that
 * follows. A finished run settles its clients from the stream's own decision
 * instead (see `decideStreamAction` and the stream route), so its events are
 * never replayed.
 *
 * A buffer normally holds one run (it is cleared when the next one starts), so
 * this is either the whole buffer or nothing.
 */
export function liveRunEvents(events: readonly BufferedEvent[]): BufferedEvent[] {
  let start = 0;
  events.forEach((event, index) => {
    if (isTerminalBufferedEvent(event)) start = index + 1;
  });
  return events.slice(start);
}

/**
 * The buffered events of the live run, with ID greater than lastEventId.
 *
 * The replay a connecting client gets: only what is still being written. See
 * `liveRunEvents` for why a finished run is skipped.
 */
export async function getLiveRunEvents(
  sessionId: string,
  lastEventId: number,
): Promise<BufferedEvent[]> {
  return liveRunEvents(await getBufferedEvents(sessionId, lastEventId));
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
 * run. not about the backlog behind it.
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
    // Also forget the throttle state: a generation that starts within a second
    // of the last buffered token of the previous one must still get its first
    // snapshot into the (now empty) buffer, or a client reconnecting early
    // replays nothing until the next one.
    lastCumulativeBufferedAt.delete(sessionId);
    await redis.del(bufKey);
  } catch (err) {
    console.error("Failed to clear SSE buffer:", err);
  }
}
