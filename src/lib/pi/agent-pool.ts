import type { AgentSession } from "@earendil-works/pi-coding-agent";
import path from "path";

interface PooledSession {
  session: AgentSession;
  sessionDir: string;
  lastPromptedMessageId: string | null; // ChatMessage.id from DB — prevents double-prompting
  lastActive: number; // Date.now() — for idle eviction
}

const pool = new Map<string, PooledSession>();

/**
 * Per-session SSE dispatcher for emitting stream events.
 *
 * Lives alongside the pool so it survives across requests for the same session.
 * The approval wrapper (baked into pooled agents) captures this dispatcher by
 * session key — not by closure — so it always emits to the current active
 * connection, not a stale one from a previous request.
 *
 * Access via getDispatcher(sessionId) / wireDispatcher(sessionId, controller, encoder).
 */
import { SseDispatcher } from "@/lib/pi/sse-dispatcher";
const dispatchers = new Map<string, SseDispatcher>();

/** Get or create the dispatcher for a session. */
export function getDispatcher(sessionId: string): SseDispatcher {
  let dispatcher = dispatchers.get(sessionId);
  if (!dispatcher) {
    dispatcher = new SseDispatcher(sessionId);
    dispatchers.set(sessionId, dispatcher);
  }
  return dispatcher;
}

/** Clear the dispatcher when the session is removed from the pool. */
export async function clearDispatcher(sessionId: string): Promise<void> {
  const dispatcher = dispatchers.get(sessionId);
  if (dispatcher) {
    await dispatcher.cleanup();
  }
  dispatchers.delete(sessionId);
}
const MAX_IDLE_MS = 30 * 60 * 1000; // 30 minutes
const MAX_POOL_SIZE = 100;

/** Build a unique pool key from userId + chatSessionId. */
export function getPoolKey(userId: string, sessionId: string): string {
  return `${userId}:${sessionId}`;
}

/**
 * Build the directory path for a chat session's Pi JSONL files.
 *
 * Stored under UPLOADS_DIR/pi_sessions/{userId}/{chatSessionId}/
 * Survives process restarts (persistent uploads volume in Docker).
 */
export function getSessionDir(userId: string, sessionId: string): string {
  const uploadsDir = process.env.UPLOADS_DIR ?? "./uploads";
  return path.join(uploadsDir, "pi_sessions", userId, sessionId);
}

/**
 * Get an existing pooled session, or throw if not present.
 * Updates lastActive timestamp on hit.
 */
export function get(key: string): PooledSession | undefined {
  const entry = pool.get(key);
  if (entry) {
    entry.lastActive = Date.now();
  }
  return entry;
}

/**
 * Get or create a pooled session.
 * If the session already exists, returns it (updates lastActive).
 * Otherwise calls createFn to build a new one and adds it to the pool.
 * Runs idle eviction before creating new entries.
 */
export async function createAndPool(
  key: string,
  createFn: () => Promise<{ session: AgentSession; sessionDir: string }>,
): Promise<PooledSession> {
  const existing = pool.get(key);
  if (existing) {
    existing.lastActive = Date.now();
    return existing;
  }

  evictIdle();

  const { session, sessionDir } = await createFn();
  const entry: PooledSession = {
    session,
    sessionDir,
    lastPromptedMessageId: null,
    lastActive: Date.now(),
  };
  pool.set(key, entry);
  return entry;
}

/**
 * Remove a session from the pool and dispose its agent.
 * The session file on disk is preserved — the agent can be recreated later.
 *
 * The pool key is "userId:sessionId" but dispatchers are keyed by sessionId,
 * so we extract the sessionId from the pool key for cleanup.
 */
export async function remove(key: string): Promise<void> {
  const entry = pool.get(key);
  if (entry) {
    entry.session.dispose();
    pool.delete(key);
  }
  // Dispatchers are keyed by sessionId, not pool key
  const sessionId = key.split(":").slice(1).join(":");
  await clearDispatcher(sessionId);
}

/**
 * Evict idle sessions (not accessed within MAX_IDLE_MS and not streaming).
 * Also enforces the hard pool size cap by evicting the oldest idle sessions.
 */
export async function evictIdle(): Promise<void> {
  const now = Date.now();
  const toEvict: string[] = [];

  // Collect idle sessions for eviction
  for (const [key, entry] of pool) {
    if (now - entry.lastActive > MAX_IDLE_MS && !entry.session.isStreaming) {
      toEvict.push(key);
    }
  }

  // Evict collected sessions
  for (const key of toEvict) {
    const entry = pool.get(key);
    if (entry) {
      entry.session.dispose();
      pool.delete(key);
    }
    // Dispatchers are keyed by sessionId, not pool key
    const sessionId = key.split(":").slice(1).join(":");
    await clearDispatcher(sessionId);
  }

  // Hard cap — evict oldest idle sessions if over limit
  while (pool.size > MAX_POOL_SIZE) {
    const sorted = [...pool.entries()].sort((a, b) => a[1].lastActive - b[1].lastActive);
    const oldest = sorted[0];
    if (!oldest) break;
    const [oldestKey, oldestEntry] = oldest;
    if (pool.has(oldestKey)) {
      oldestEntry.session.dispose();
      pool.delete(oldestKey);
    }
    // Dispatchers are keyed by sessionId, not pool key
    const sessionId = oldestKey.split(":").slice(1).join(":");
    await clearDispatcher(sessionId);
  }
}

/**
 * Get current pool size (exported for testing).
 */
export function getPoolSize(): number {
  return pool.size;
}

/**
 * Get all pool keys (exported for testing).
 */
export function getPoolKeys(): string[] {
  return [...pool.keys()];
}

/**
 * Clear the entire pool and dispose all agents (exported for testing).
 */
export async function clearPool(): Promise<void> {
  clearInterval(timer);
  for (const [, entry] of pool) {
    entry.session.dispose();
  }
  pool.clear();
  // Clean up all dispatchers
  for (const [key] of dispatchers) {
    await clearDispatcher(key);
  }
}

/**
 * Graceful shutdown — dispose all agents and clear the pool.
 * Call this during process shutdown to ensure clean resource release.
 */
export async function shutdown(): Promise<void> {
  clearInterval(timer);
  for (const [, entry] of pool) {
    entry.session.dispose();
  }
  pool.clear();
  // Clean up all dispatchers
  for (const [key] of dispatchers) {
    await clearDispatcher(key);
  }
}

// Periodic eviction — runs every 5 minutes
const timer = setInterval(
  () => {
    evictIdle().catch((err) => {
      console.error("[agent-pool] Eviction failed:", err);
    });
  },
  5 * 60 * 1000,
);
timer.unref(); // Don't keep process alive
