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
    // If Redis is down, don't block requests — log and allow through
    console.error("Rate limiter Redis error (allowing request):", err);
    return false;
  }
}

// ─── Active Session Tracking ────────────────────────────────────────────────

/**
 * Redis-backed active session tracking.
 *
 * Stores session IDs that have an active agent generation, keyed by user.
 * Key format: `active_sessions:{userId}` (Redis SET of session IDs)
 * TTL: 10 minutes (auto-cleanup for stale entries)
 */

const ACTIVE_SESSION_PREFIX = "active_sessions:";
const ACTIVE_SESSION_TTL_SECONDS = 600;

/** Register a session as active (has a running agent). */
export async function registerActiveSession(userId: string, sessionId: string): Promise<void> {
  try {
    const redis = getRedis();
    const key = `${ACTIVE_SESSION_PREFIX}${userId}`;
    await redis.sadd(key, sessionId);
    await redis.expire(key, ACTIVE_SESSION_TTL_SECONDS);
  } catch (err) {
    console.error("Failed to register active session:", err);
  }
}

/** Check if a session is active (has a running agent). */
export async function isSessionActive(userId: string, sessionId: string): Promise<boolean> {
  try {
    const redis = getRedis();
    const key = `${ACTIVE_SESSION_PREFIX}${userId}`;
    return (await redis.sismember(key, sessionId)) === 1;
  } catch (err) {
    console.error("Failed to check active session:", err);
    return false;
  }
}

/** Unregister a session (generation complete or aborted). */
export async function unregisterActiveSession(userId: string, sessionId: string): Promise<void> {
  try {
    const redis = getRedis();
    const key = `${ACTIVE_SESSION_PREFIX}${userId}`;
    await redis.srem(key, sessionId);
  } catch (err) {
    console.error("Failed to unregister active session:", err);
  }
}

/** Get all active session IDs for a user. */
export async function getActiveSessions(userId: string): Promise<Set<string>> {
  try {
    const redis = getRedis();
    const key = `${ACTIVE_SESSION_PREFIX}${userId}`;
    const members = await redis.smembers(key);
    return new Set(members);
  } catch (err) {
    console.error("Failed to get active sessions:", err);
    return new Set();
  }
}

// ─── Generation Start Tracking ───────────────────────────────────────────────

/**
 * Redis-backed "when did the current generation start" tracking.
 *
 * Used to detect stale generations: if a session is registered as active but
 * has produced no buffered events for a long time (e.g. the client died right
 * after POST /messages), a new SSE connection takes over and prompts instead
 * of waiting forever.
 */

const GEN_START_PREFIX = "chat:gen_start:";

/** Record when a generation started for a session. */
export async function markGenerationStart(sessionId: string): Promise<void> {
  try {
    const redis = getRedis();
    await redis.set(
      `${GEN_START_PREFIX}${sessionId}`,
      Date.now().toString(),
      "EX",
      ACTIVE_SESSION_TTL_SECONDS,
    );
  } catch (err) {
    console.error("Failed to mark generation start:", err);
  }
}

/** Get the epoch-ms timestamp when the current generation started (or null). */
export async function getGenerationStartedAt(sessionId: string): Promise<number | null> {
  try {
    const redis = getRedis();
    const value = await redis.get(`${GEN_START_PREFIX}${sessionId}`);
    return value ? parseInt(value, 10) : null;
  } catch (err) {
    console.error("Failed to read generation start:", err);
    return null;
  }
}

// ─── Pending Prompt Claim ────────────────────────────────────────────────────

/**
 * Redis-backed pending-prompt claim.
 *
 * POST /api/chat/sessions/:id/messages (and the edit route) save the user
 * message, register the session as active, and store the message ID here. The
 * SSE stream connection for that message is the expected prompter — this key
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

/**
 * Atomically claim the pending prompt (GETDEL).
 *
 * Returns the claimed message ID, or null if there was nothing to claim.
 * Used by the stream route to arbitrate between concurrent connections that
 * both decided to prompt — exactly one wins the GETDEL.
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
