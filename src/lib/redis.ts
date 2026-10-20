import { Redis } from "ioredis";

let redisInstance: Redis | null = null;

export function getRedis(): Redis {
  if (!redisInstance) {
    redisInstance = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
      maxRetriesPerRequest: 3,
      retryStrategy: (times) => Math.min(times * 50, 2000),
    });
  }
  return redisInstance;
}

/** Create a new, independent Redis client (e.g. for pub/sub subscribers that need their own connection). */
export function createRedisClient(): Redis {
  return new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
    maxRetriesPerRequest: 3,
    retryStrategy: (times) => Math.min(times * 50, 2000),
  });
}

export async function closeRedis(): Promise<void> {
  if (redisInstance) {
    await redisInstance.quit();
    redisInstance = null;
  }
}

// ─── Rate Limiting ──────────────────────────────────────────────────────────

/**
 * Redis-backed rate limiter.
 *
 * Uses an atomic INCR + EXPIRE pattern so it works across multiple instances.
 * Key format: `ratelimit:{key}`
 */

const RATE_LIMIT_PREFIX = "ratelimit:";
const RATE_LIMIT_WINDOW_SECONDS = 60;
const RATE_LIMIT_MAX = 60;

/**
 * Check if a key is rate limited. Returns true if the limit is exceeded.
 *
 * Uses a single Redis pipeline (INCR + EXPIRE) for atomicity.
 */
export async function isRateLimited(key: string): Promise<boolean> {
  try {
    const redis = getRedis();
    const redisKey = `${RATE_LIMIT_PREFIX}${key}`;
    const current = await redis.incr(redisKey);
    if (current === 1) {
      await redis.expire(redisKey, RATE_LIMIT_WINDOW_SECONDS);
    }
    return current > RATE_LIMIT_MAX;
  } catch (err) {
    // If Redis is down, don't block requests. log and allow through
    console.error("Rate limiter Redis error (allowing request):", err);
    return false;
  }
}

// ─── Active Session Tracking ────────────────────────────────────────────────

/**
 * Redis-backed active session tracking, with liveness.
 *
 * A chat generation runs in whichever process owns the pooled agent (the web
 * process, or the worker running Telegram agents). Every other process. and
 * every connected SSE client. has to know whether it is still running.
 *
 * Liveness is carried by a short-TTL heartbeat key per session, refreshed by
 * the session event tracker while Pi streams:
 *
 *   `chat:gen_active:{userId}:{sessionId}`. TTL ACTIVE_SESSION_TTL_SECONDS
 *
 * The short TTL is the crash detector. A process that dies mid-generation
 * (deploy, restart, OOM) simply stops refreshing, so the session reads as
 * inactive seconds later. The flag used to live for ten minutes with no
 * refresh, which meant a restarted Saale kept believing in a generation that
 * no longer existed: clients replayed a frozen stream forever, and Stop could
 * not settle them (see the stream route's stale-generation supervisor).
 *
 * `active_sessions:{userId}` is only an index for enumerating a user's
 * sessions; every candidate is verified against its own heartbeat key, so a
 * dead session's lingering membership is never reported as active.
 */

const ACTIVE_SESSION_PREFIX = "active_sessions:";
const ACTIVE_SESSION_KEY_PREFIX = "chat:gen_active:";
const ACTIVE_SESSION_INDEX_TTL_SECONDS = 600;

/** How long a generation's heartbeat stays valid. the crash-detection window. */
export const ACTIVE_SESSION_TTL_SECONDS = 30;

/**
 * How often the running generation refreshes its heartbeat.
 *
 * Must stay well inside {@link ACTIVE_SESSION_TTL_SECONDS}: the flag has to
 * survive a couple of missed beats (a busy event loop, a slow Redis round
 * trip) without ever letting a live generation look dead to the recovery path.
 */
export const ACTIVE_SESSION_HEARTBEAT_MS = 10_000;

const activeSessionKey = (userId: string, sessionId: string) =>
  `${ACTIVE_SESSION_KEY_PREFIX}${userId}:${sessionId}`;

/** Register a session as active (has a running agent), or refresh its heartbeat. */
export async function registerActiveSession(userId: string, sessionId: string): Promise<void> {
  try {
    const redis = getRedis();
    const indexKey = `${ACTIVE_SESSION_PREFIX}${userId}`;
    await redis.sadd(indexKey, sessionId);
    await redis.expire(indexKey, ACTIVE_SESSION_INDEX_TTL_SECONDS);
    await redis.set(activeSessionKey(userId, sessionId), "1", "EX", ACTIVE_SESSION_TTL_SECONDS);
  } catch (err) {
    console.error("Failed to register active session:", err);
  }
}

/** Check if a session is active (has a running agent, refreshed within the TTL). */
export async function isSessionActive(userId: string, sessionId: string): Promise<boolean> {
  try {
    const redis = getRedis();
    return (await redis.get(activeSessionKey(userId, sessionId))) !== null;
  } catch (err) {
    console.error("Failed to check active session:", err);
    return false;
  }
}

/** Unregister a session (generation complete or aborted). */
export async function unregisterActiveSession(userId: string, sessionId: string): Promise<void> {
  try {
    const redis = getRedis();
    await redis.srem(`${ACTIVE_SESSION_PREFIX}${userId}`, sessionId);
    await redis.del(activeSessionKey(userId, sessionId));
  } catch (err) {
    console.error("Failed to unregister active session:", err);
  }
}

/** Get all active session IDs for a user (index members whose heartbeat is still live). */
export async function getActiveSessions(userId: string): Promise<Set<string>> {
  try {
    const redis = getRedis();
    const members = await redis.smembers(`${ACTIVE_SESSION_PREFIX}${userId}`);
    if (members.length === 0) return new Set();
    const heartbeats = await redis.mget(members.map((id) => activeSessionKey(userId, id)));
    return new Set(members.filter((_, index) => heartbeats[index] != null));
  } catch (err) {
    console.error("Failed to get active sessions:", err);
    return new Set();
  }
}

// ─── Compaction-in-Progress Tracking ────────────────────────────────────────

/**
 * Redis-backed "a manual compaction holds this session" flag.
 *
 * Pi refuses to submit a prompt while a compaction runs, and `compact()`
 * aborts any generation it finds. so a compaction cannot masquerade as an
 * active session (unregistering one must never clear the other). It is a busy
 * state of its own: POST /messages consults it via `isSessionBusy`, so a
 * message sent mid-compaction is queued like one sent mid-generation instead
 * of racing the summarization into a rejection.
 *
 * Key format: `chat:compacting:{sessionId}`, refreshed by the compaction
 * request for as long as it runs.
 */

const COMPACTING_PREFIX = "chat:compacting:";
const COMPACTING_TTL_SECONDS = 600;

/** Mark the session as held by a manual compaction. */
export async function markCompactionInProgress(sessionId: string): Promise<void> {
  try {
    const redis = getRedis();
    await redis.set(`${COMPACTING_PREFIX}${sessionId}`, "1", "EX", COMPACTING_TTL_SECONDS);
  } catch (err) {
    console.error("Failed to mark compaction in progress:", err);
  }
}

/** Whether a manual compaction currently holds the session. */
export async function isCompactionInProgress(sessionId: string): Promise<boolean> {
  try {
    const redis = getRedis();
    return (await redis.exists(`${COMPACTING_PREFIX}${sessionId}`)) === 1;
  } catch (err) {
    console.error("Failed to read the compaction flag:", err);
    return false;
  }
}

/** Clear the compaction flag once the compaction settled (or failed). */
export async function clearCompactionInProgress(sessionId: string): Promise<void> {
  try {
    const redis = getRedis();
    await redis.del(`${COMPACTING_PREFIX}${sessionId}`);
  } catch (err) {
    console.error("Failed to clear the compaction flag:", err);
  }
}

/**
 * Is the session busy. a generation streaming, or a manual compaction holding
 * it? Both refuse a prompt, so a message sent now has to wait in the send queue
 * instead of being prompted into a rejection.
 */
export async function isSessionBusy(userId: string, sessionId: string): Promise<boolean> {
  const [active, compacting] = await Promise.all([
    isSessionActive(userId, sessionId),
    isCompactionInProgress(sessionId),
  ]);
  return active || compacting;
}

// ─── Pending Prompt Claim ────────────────────────────────────────────────────

/**
 * Redis-backed pending-prompt claim.
 *
 * POST /api/chat/sessions/:id/messages (and the edit route) save the user
 * message, register the session as active, and store the message ID here. The
 * SSE stream connection for that message is the expected prompter. this key
 * tells it so, and tells every other connection to just observe.
 */

const PENDING_PROMPT_PREFIX = "chat:pending_prompt:";
const PENDING_PROMPT_TTL_SECONDS = 600;

/** Mark a message as awaiting its SSE connection to prompt it. */
export async function setPendingPrompt(sessionId: string, messageId: string): Promise<void> {
  try {
    const redis = getRedis();
    await redis.set(
      `${PENDING_PROMPT_PREFIX}${sessionId}`,
      messageId,
      "EX",
      PENDING_PROMPT_TTL_SECONDS,
    );
  } catch (err) {
    console.error("Failed to set pending prompt:", err);
  }
}

/** Read the pending-prompt message ID for a session (or null). */
export async function getPendingPrompt(sessionId: string): Promise<string | null> {
  try {
    const redis = getRedis();
    return await redis.get(`${PENDING_PROMPT_PREFIX}${sessionId}`);
  } catch (err) {
    console.error("Failed to read pending prompt:", err);
    return null;
  }
}

// ─── Pending History Rewind ─────────────────────────────────────────────────

/**
 * Redis-backed history-rewind claim.
 *
 * Editing a message rewrites the DB history, but the agent's own transcript is
 * append-only: the SDK appends the edited prompt to a transcript that still
 * holds the messages the edit deleted, so the model reads the edit as a brand
 * new message following the old, deleted conversation.
 *
 * The edit route stores the message's pre-edit content here; the SSE
 * connection that prompts it claims the entry and rewinds the transcript first
 * (see rewindSessionToMessage).
 */

const PENDING_REWIND_PREFIX = "chat:pending_rewind:";
const PENDING_REWIND_TTL_SECONDS = 600;

export interface PendingHistoryRewind {
  /** The edited message, which is about to be prompted again. */
  messageId: string;
  /** The message's content before the edit. locates its transcript entry. */
  previousContent: string;
  /** Position of the message among the session's saved user messages. */
  userMessageIndex: number;
}

/** Mark a message's transcript as needing a rewind before it is re-prompted. */
export async function setPendingHistoryRewind(
  sessionId: string,
  rewind: PendingHistoryRewind,
): Promise<void> {
  try {
    const redis = getRedis();
    await redis.set(
      `${PENDING_REWIND_PREFIX}${sessionId}`,
      JSON.stringify(rewind),
      "EX",
      PENDING_REWIND_TTL_SECONDS,
    );
  } catch (err) {
    console.error("Failed to set pending history rewind:", err);
  }
}

/** Read the session's pending history rewind (or null). */
export async function getPendingHistoryRewind(
  sessionId: string,
): Promise<PendingHistoryRewind | null> {
  try {
    const redis = getRedis();
    const value = await redis.get(`${PENDING_REWIND_PREFIX}${sessionId}`);
    if (!value) return null;
    return JSON.parse(value) as PendingHistoryRewind;
  } catch (err) {
    console.error("Failed to read pending history rewind:", err);
    return null;
  }
}

/**
 * Atomically claim the pending history rewind (GETDEL), so exactly one of the
 * concurrent connections that decided to prompt consumes it.
 */
export async function claimPendingHistoryRewind(
  sessionId: string,
): Promise<PendingHistoryRewind | null> {
  try {
    const redis = getRedis();
    const value = await redis.getdel(`${PENDING_REWIND_PREFIX}${sessionId}`);
    if (!value) return null;
    return JSON.parse(value) as PendingHistoryRewind;
  } catch (err) {
    console.error("Failed to claim pending history rewind:", err);
    return null;
  }
}

// ─── Send Queue Hold ────────────────────────────────────────────────────────

/**
 * A stopped session stops sending its queue too.
 *
 * Stop means "nothing more until I say so": without this, the send queue's
 * drain would immediately deliver the messages that were queued during the run
 * the user just cancelled. The hold is cleared by the actions that express
 * "keep going". a new message, or pushing a queued one.
 */

const QUEUE_HOLD_PREFIX = "chat:queue_hold:";
const QUEUE_HOLD_TTL_SECONDS = 600;

/** Pause the session's send queue (called by the stop route). */
export async function holdSendQueue(sessionId: string): Promise<void> {
  try {
    const redis = getRedis();
    await redis.set(`${QUEUE_HOLD_PREFIX}${sessionId}`, "1", "EX", QUEUE_HOLD_TTL_SECONDS);
  } catch (err) {
    console.error("Failed to hold send queue:", err);
  }
}

/** Whether the session's send queue is paused. */
export async function isSendQueueHeld(sessionId: string): Promise<boolean> {
  try {
    const redis = getRedis();
    return (await redis.exists(`${QUEUE_HOLD_PREFIX}${sessionId}`)) === 1;
  } catch (err) {
    console.error("Failed to read send queue hold:", err);
    return false;
  }
}

/** Resume the session's send queue (a new message, or an explicit "send now"). */
export async function releaseSendQueue(sessionId: string): Promise<void> {
  try {
    const redis = getRedis();
    await redis.del(`${QUEUE_HOLD_PREFIX}${sessionId}`);
  } catch (err) {
    console.error("Failed to release send queue:", err);
  }
}

/**
 * Atomically claim the pending prompt (GETDEL).
 *
 * Returns the claimed message ID, or null if there was nothing to claim.
 * Used by the stream route to arbitrate between concurrent connections that
 * both decided to prompt. exactly one wins the GETDEL.
 */
export async function claimPendingPrompt(sessionId: string): Promise<string | null> {
  try {
    const redis = getRedis();
    return await redis.getdel(`${PENDING_PROMPT_PREFIX}${sessionId}`);
  } catch (err) {
    console.error("Failed to claim pending prompt:", err);
    return null;
  }
}
