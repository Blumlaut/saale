/**
 * In-memory Redis implementation for tests.
 *
 * Drop-in replacement for `@/lib/redis` in test files that exercise code
 * which really depends on Redis semantics (stateful reads/writes, TTL,
 * SCAN/MGET, sorted sets, and cross-client pub/sub delivery between the
 * `getRedis()` publisher and the `createRedisClient()` subscriber).
 *
 * Usage in a test file:
 *
 *   vi.mock("@/lib/redis", () => import("../../helpers/in-memory-redis"));
 *   import { resetMockRedis } from "../../helpers/in-memory-redis";
 *   beforeEach(() => resetMockRedis());
 *
 * No external server or binary is needed — everything lives in module state.
 */

// ─── Shared state ────────────────────────────────────────────────────────────

type Entry =
  | { kind: "string"; value: string; expiresAt: number | null }
  | { kind: "set"; members: Set<string>; expiresAt: number | null }
  | { kind: "zset"; members: Map<string, number>; expiresAt: number | null };

const store = new Map<string, Entry>();
/** channel → clients subscribed to it (pub/sub) */
const subscribers = new Map<string, Set<MemoryRedisClient>>();
/** per-client event handlers (needed so publish() can reach subscriber handlers) */
const clientHandlers = new WeakMap<MemoryRedisClient, Map<string, Set<MessageHandler>>>();

function nowMs(): number {
  return Date.now();
}

function isEntryExpired(entry: Entry): boolean {
  return entry.expiresAt !== null && entry.expiresAt <= nowMs();
}

function getEntry(key: string): Entry | undefined {
  const entry = store.get(key);
  if (!entry) return undefined;
  if (isEntryExpired(entry)) {
    store.delete(key);
    return undefined;
  }
  return entry;
}

function setString(key: string, value: string, ttlSeconds?: number): void {
  store.set(key, {
    kind: "string",
    value,
    expiresAt: ttlSeconds !== undefined ? nowMs() + ttlSeconds * 1000 : null,
  });
}

/** Redis glob (`*`, `?`, `[...]`) to RegExp. */
function globToRegExp(pattern: string): RegExp {
  let out = "^";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === undefined) break;
    if (ch === "*") {
      out += ".*";
    } else if (ch === "?") {
      out += ".";
    } else if (ch === "[") {
      const end = pattern.indexOf("]", i + 1);
      if (end === -1) {
        out += "\\[";
      } else {
        const cls = pattern.slice(i + 1, end).replace(/[\\^]/g, "\\$&");
        out += `[${cls}]`;
        i = end;
      }
    } else {
      out += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`${out}$`);
}

// ─── Client ─────────────────────────────────────────────────────────────────

/** Handler signature for the `.on("message")` subscriber callback. */
type MessageHandler = (channel: string, message: string) => void;

export interface MemoryRedisClient {
  // strings
  set(key: string, value: string, ...args: unknown[]): Promise<string>;
  setex(key: string, seconds: number, value: string): Promise<string>;
  get(key: string): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
  ttl(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  incr(key: string): Promise<number>;
  getdel(key: string): Promise<string | null>;
  // sets
  sadd(key: string, member: string): Promise<number>;
  srem(key: string, member: string): Promise<number>;
  sismember(key: string, member: string): Promise<number>;
  smembers(key: string): Promise<string[]>;
  // sorted sets
  zadd(key: string, score: number, member: string): Promise<number>;
  zremrangebyrank(key: string, start: number, stop: number): Promise<number>;
  zrangebyscore(key: string, min: number | string, max: number | string): Promise<string[]>;
  zrevrange(key: string, start: number, stop: number, withScores?: string): Promise<string[]>;
  zcard(key: string): Promise<number>;
  // scan / mget
  scan(
    cursor: number | string,
    matchMode: string,
    pattern: string,
    countMode: string,
    count: number,
  ): Promise<[string, string[]]>;
  mget(keys: string[]): Promise<Array<string | null>>;
  // pub/sub
  publish(channel: string, message: string): Promise<number>;
  subscribe(...channels: string[]): Promise<unknown>;
  unsubscribe(...channels: string[]): Promise<unknown>;
  on(event: string, handler: MessageHandler): MemoryRedisClient;
  quit(): Promise<"OK">;
}

function createClient(): MemoryRedisClient {
  const handlers = new Map<string, Set<MessageHandler>>();
  const subscribedChannels = new Set<string>();

  const client: MemoryRedisClient = {
    // ── strings ────────────────────────────────────────────────────────────

    async set(key, value, ...args) {
      let ttlSeconds: number | undefined;
      if (args[0] === "EX") ttlSeconds = Number(args[1]);
      else if (args[0] === "PX") ttlSeconds = Number(args[1]) / 1000;
      setString(key, value, ttlSeconds);
      return "OK";
    },

    async setex(key, seconds, value) {
      setString(key, value, seconds);
      return "OK";
    },

    async get(key) {
      const entry = getEntry(key);
      return entry?.kind === "string" ? entry.value : null;
    },

    async del(...keys) {
      let removed = 0;
      for (const key of keys) {
        if (store.delete(key)) removed += 1;
      }
      return removed;
    },

    async ttl(key) {
      const entry = store.get(key);
      if (!entry || isEntryExpired(entry)) return -2;
      if (entry.expiresAt === null) return -1;
      return Math.max(Math.ceil((entry.expiresAt - nowMs()) / 1000), 0);
    },

    async expire(key, seconds) {
      const entry = store.get(key);
      if (!entry) return 0;
      entry.expiresAt = nowMs() + seconds * 1000;
      return 1;
    },

    async incr(key) {
      const entry = getEntry(key);
      const current = entry?.kind === "string" ? Number(entry.value) : 0;
      const next = Number.isFinite(current) ? current + 1 : 1;
      // Redis INCR preserves an existing TTL.
      const expiresAt = entry?.expiresAt ?? null;
      store.set(key, { kind: "string", value: String(next), expiresAt });
      return next;
    },

    async getdel(key) {
      const entry = getEntry(key);
      if (entry?.kind !== "string") return null;
      store.delete(key);
      return entry.value;
    },

    // ── sets ───────────────────────────────────────────────────────────────

    async sadd(key, member) {
      let entry = getEntry(key);
      if (entry?.kind === "set") {
        if (entry.members.has(member)) return 0;
        entry.members.add(member);
        return 1;
      }
      entry = { kind: "set", members: new Set([member]), expiresAt: null };
      store.set(key, entry);
      return 1;
    },

    async srem(key, member) {
      const entry = getEntry(key);
      if (entry?.kind !== "set") return 0;
      return entry.members.delete(member) ? 1 : 0;
    },

    async sismember(key, member) {
      const entry = getEntry(key);
      return entry?.kind === "set" && entry.members.has(member) ? 1 : 0;
    },

    async smembers(key) {
      const entry = getEntry(key);
      return entry?.kind === "set" ? [...entry.members] : [];
    },

    // ── sorted sets ────────────────────────────────────────────────────────

    async zadd(key, score, member) {
      let entry = getEntry(key);
      if (entry?.kind !== "zset") {
        entry = { kind: "zset", members: new Map(), expiresAt: null };
        store.set(key, entry);
      }
      const isNew = !entry.members.has(member);
      entry.members.set(member, score);
      return isNew ? 1 : 0;
    },

    async zremrangebyrank(key, start, stop) {
      const entry = getEntry(key);
      if (entry?.kind !== "zset") return 0;
      const sorted = [...entry.members.entries()].sort((a, b) => a[1] - b[1]);
      const len = sorted.length;
      const norm = (i: number): number => (i < 0 ? Math.max(len + i, 0) : Math.min(i, len - 1));
      const lo = norm(start);
      const hi = norm(stop);
      let removed = 0;
      for (let i = lo; i <= hi && i < len; i++) {
        entry.members.delete(sorted[i]![0]);
        removed += 1;
      }
      return removed;
    },

    async zrangebyscore(key, min, max) {
      const entry = getEntry(key);
      if (entry?.kind !== "zset") return [];
      const minScore = min === "-inf" ? Number.NEGATIVE_INFINITY : Number(min);
      const maxScore = max === "+inf" ? Number.POSITIVE_INFINITY : Number(max);
      return [...entry.members.entries()]
        .filter(([, score]) => score >= minScore && score <= maxScore)
        .sort((a, b) => a[1] - b[1])
        .map(([member]) => member);
    },

    async zrevrange(key, start, stop, withScores) {
      const entry = getEntry(key);
      if (entry?.kind !== "zset") return [];
      const sorted = [...entry.members.entries()].sort((a, b) => b[1] - a[1]);
      const len = sorted.length;
      const norm = (i: number): number => (i < 0 ? Math.max(len + i, 0) : Math.min(i, len - 1));
      const lo = norm(start);
      const hi = norm(stop);
      const out: string[] = [];
      for (let i = lo; i <= hi && i < len; i++) {
        out.push(sorted[i]![0]);
        if (withScores === "WITHSCORES") out.push(String(sorted[i]![1]));
      }
      return out;
    },

    async zcard(key) {
      const entry = getEntry(key);
      return entry?.kind === "zset" ? entry.members.size : 0;
    },

    // ── scan / mget ────────────────────────────────────────────────────────

    async scan(cursor, _matchMode, pattern, _countMode, _count) {
      const regex = globToRegExp(pattern);
      const keys = [...store.keys()]
        .filter((key) => regex.test(key))
        .filter((key) => {
          const entry = store.get(key);
          return entry !== undefined && !isEntryExpired(entry);
        });
      // Single-page scan: return everything and signal the end with cursor 0.
      return ["0", keys];
    },

    async mget(keys) {
      return keys.map((key) => {
        const entry = getEntry(key);
        return entry?.kind === "string" ? entry.value : null;
      });
    },

    // ── pub/sub ────────────────────────────────────────────────────────────

    async publish(channel, message) {
      const clients = subscribers.get(channel);
      if (!clients || clients.size === 0) return 0;
      let delivered = 0;
      for (const subscriberClient of clients) {
        const messageHandlers = clientHandlers.get(subscriberClient)?.get("message");
        if (!messageHandlers) continue;
        for (const handler of messageHandlers) {
          handler(channel, message);
          delivered += 1;
        }
      }
      return delivered;
    },

    async subscribe(...channels) {
      for (const channel of channels) {
        let clients = subscribers.get(channel);
        if (!clients) {
          clients = new Set();
          subscribers.set(channel, clients);
        }
        clients.add(this);
        subscribedChannels.add(channel);
      }
      return "OK";
    },

    async unsubscribe(...channels) {
      for (const channel of channels) {
        subscribers.get(channel)?.delete(this);
        subscribedChannels.delete(channel);
      }
      return "OK";
    },

    on(event, handler) {
      let set = handlers.get(event);
      if (!set) {
        set = new Set();
        handlers.set(event, set);
      }
      set.add(handler);
      return client;
    },

    async quit() {
      for (const channel of subscribedChannels) {
        subscribers.get(channel)?.delete(client);
      }
      subscribedChannels.clear();
      return "OK";
    },
  };

  clientHandlers.set(client, handlers);
  return client;
}

// ─── Module exports (mirrors `@/lib/redis`) ─────────────────────────────────

let redisInstance: MemoryRedisClient | null = null;

export function getRedis(): MemoryRedisClient {
  if (!redisInstance) redisInstance = createClient();
  return redisInstance;
}

/** Create a new, independent client (e.g. the pub/sub subscriber). */
export function createRedisClient(): MemoryRedisClient {
  return createClient();
}

export async function closeRedis(): Promise<void> {
  redisInstance = null;
}

// ─── Test utilities ─────────────────────────────────────────────────────────

/**
 * Clear all in-memory state. Call in `beforeEach` so tests start clean.
 */
export function resetMockRedis(): void {
  store.clear();
  subscribers.clear();
  redisInstance = null;
}

// ─── Rate limiting / session tracking helpers (same surface as redis.ts) ────

const RATE_LIMIT_PREFIX = "ratelimit:";
const RATE_LIMIT_WINDOW_SECONDS = 60;
const RATE_LIMIT_MAX = 60;

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
    console.error("Rate limiter Redis error (allowing request):", err);
    return false;
  }
}

const ACTIVE_SESSION_PREFIX = "active_sessions:";
const ACTIVE_SESSION_TTL_SECONDS = 600;

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

export async function unregisterActiveSession(userId: string, sessionId: string): Promise<void> {
  try {
    const redis = getRedis();
    const key = `${ACTIVE_SESSION_PREFIX}${userId}`;
    await redis.srem(key, sessionId);
  } catch (err) {
    console.error("Failed to unregister active session:", err);
  }
}

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

const GEN_START_PREFIX = "chat:gen_start:";

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

const PENDING_PROMPT_PREFIX = "chat:pending_prompt:";
const PENDING_PROMPT_TTL_SECONDS = 600;

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

export async function getPendingPrompt(sessionId: string): Promise<string | null> {
  try {
    const redis = getRedis();
    return await redis.get(`${PENDING_PROMPT_PREFIX}${sessionId}`);
  } catch (err) {
    console.error("Failed to read pending prompt:", err);
    return null;
  }
}

export async function claimPendingPrompt(sessionId: string): Promise<string | null> {
  try {
    const redis = getRedis();
    return await redis.getdel(`${PENDING_PROMPT_PREFIX}${sessionId}`);
  } catch (err) {
    console.error("Failed to claim pending prompt:", err);
    return null;
  }
}
