import type { AgentSession } from "@earendil-works/pi-coding-agent";
import path from "path";

interface PooledSession {
  session: AgentSession;
  sessionDir: string;
  lastPromptedMessageId: string | null; // ChatMessage.id from DB — prevents double-prompting
  lastActive: number; // Date.now() — for idle eviction
}

const pool = new Map<string, PooledSession>();
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
 */
export function remove(key: string): void {
  const entry = pool.get(key);
  if (entry) {
    entry.session.dispose();
    pool.delete(key);
  }
}

/**
 * Evict idle sessions (not accessed within MAX_IDLE_MS and not streaming).
 * Also enforces the hard pool size cap by evicting the oldest idle sessions.
 */
export function evictIdle(): void {
  const now = Date.now();

  // Evict idle sessions
  for (const [key, entry] of pool) {
    if (now - entry.lastActive > MAX_IDLE_MS && !entry.session.isStreaming) {
      entry.session.dispose();
      pool.delete(key);
    }
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
export function clearPool(): void {
  clearInterval(timer);
  for (const [, entry] of pool) {
    entry.session.dispose();
  }
  pool.clear();
}

/**
 * Graceful shutdown — dispose all agents and clear the pool.
 * Call this during process shutdown to ensure clean resource release.
 */
export function shutdown(): void {
  clearInterval(timer);
  for (const [, entry] of pool) {
    entry.session.dispose();
  }
  pool.clear();
}

// Periodic eviction — runs every 5 minutes
const timer = setInterval(evictIdle, 5 * 60 * 1000);
timer.unref(); // Don't keep process alive
