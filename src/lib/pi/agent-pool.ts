import type { AgentSession } from "@earendil-works/pi-coding-agent";
import path from "path";
import { unwireSessionPersistence } from "@/lib/pi/session-persistence";
import { getUploadsDir } from "@/lib/uploads";

interface PooledSession {
  session: AgentSession;
  sessionDir: string;
  lastPromptedMessageId: string | null; // ChatMessage.id from DB. prevents double-prompting
  /** True while a prompt() call for this session is in flight (same-process race guard). */
  promptInFlight: boolean;
  lastActive: number; // Date.now(). for idle eviction
}

const pool = new Map<string, PooledSession>();

/**
 * Creations in flight, keyed like the pool.
 *
 * Creating a session is slow (it loads the transcript and builds the tool
 * registry), and two requests for the same chat can overlap. a message sent
 * while /compact is still spinning up its session. Without single-flight, both
 * callers would find the pool empty, create their own AgentSession over the
 * same JSONL file, and the second would overwrite the first's pool entry: two
 * live session objects appending to one transcript, one of them orphaned and
 * invisible to every later request.
 */
const pendingCreations = new Map<string, Promise<PooledSession>>();

/**
 * Bumped by teardown. A creation that started before a teardown must not pool
 * its session afterwards. that would resurrect a pool that was just cleared.
 */
let poolGeneration = 0;

/**
 * Per-session SSE dispatcher for emitting stream events.
 *
 * Lives alongside the pool so it survives across requests for the same session.
 * The approval wrapper (baked into pooled agents) captures this dispatcher by
 * session key. not by closure. so it always emits to the current active
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
    await dispatcher.dispose();
  }
  dispatchers.delete(sessionId);
}

/** Clear both dispatcher and persistence for a session. */
async function clearSessionResources(sessionId: string): Promise<void> {
  unwireSessionPersistence(sessionId);
  await clearDispatcher(sessionId);
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
  return path.join(getUploadsDir(), "pi_sessions", userId, sessionId);
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
 * Concurrent callers for the same key share one creation (single-flight).
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

  const inFlight = pendingCreations.get(key);
  if (inFlight) return inFlight;

  evictIdle();

  const generation = poolGeneration;
  const creation = createFn()
    .then(({ session, sessionDir }) => {
      const entry: PooledSession = {
        session,
        sessionDir,
        lastPromptedMessageId: null,
        promptInFlight: false,
        lastActive: Date.now(),
      };
      if (generation === poolGeneration) pool.set(key, entry);
      return entry;
    })
    .finally(() => {
      pendingCreations.delete(key);
    });

  pendingCreations.set(key, creation);
  return creation;
}

/**
 * Remove a session from the pool and dispose its agent.
 * The session file on disk is preserved. the agent can be recreated later.
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
  // Dispatchers and persistence are keyed by sessionId, not pool key
  const sessionId = key.split(":").slice(1).join(":");
  await clearSessionResources(sessionId);
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
    // Persistence and dispatchers are keyed by sessionId, not pool key
    const sessionId = key.split(":").slice(1).join(":");
    await clearSessionResources(sessionId);
  }

  // Hard cap. evict the oldest sessions that are not running. A session with a
  // run in flight (or one about to prompt, e.g. a message deferred until a
  // compaction ends) must never be disposed: that aborts the run and drops the
  // client's stream.
  while (pool.size > MAX_POOL_SIZE) {
    const sorted = [...pool.entries()]
      .filter(([, entry]) => !entry.session.isStreaming && !entry.promptInFlight)
      .sort((a, b) => a[1].lastActive - b[1].lastActive);
    const oldest = sorted[0];
    if (!oldest) {
      console.warn(
        `[agent-pool] Pool is over its limit (${pool.size}) with no idle session to evict`,
      );
      break;
    }
    const [oldestKey, oldestEntry] = oldest;
    if (pool.has(oldestKey)) {
      oldestEntry.session.dispose();
      pool.delete(oldestKey);
    }
    // Persistence and dispatchers are keyed by sessionId, not pool key
    const sessionId = oldestKey.split(":").slice(1).join(":");
    await clearSessionResources(sessionId);
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
 * Drop every pooled session belonging to one user and dispose its agents.
 *
 * The agent's model, tools and extensions (the user's MCP servers among them)
 * are fixed when the session is built, so changing a user-wide setting means
 * rebuilding. Sessions with a run in flight are left alone. disposing one
 * aborts the run. and pick up the change the next time they are rebuilt.
 */
export async function evictUserSessions(userId: string): Promise<number> {
  const prefix = `${userId}:`;
  const keys = [...pool.keys()].filter(
    (key) => key.startsWith(prefix) && !pool.get(key)?.promptInFlight,
  );

  for (const key of keys) {
    await remove(key);
  }
  return keys.length;
}

/**
 * Drop every pooled session and dispose its agents.
 *
 * A global setting (the plugin set) is baked into every session Saale builds,
 * so the whole pool has to be rebuilt. Sessions with a run in flight are left
 * alone, as in `evictUserSessions`.
 */
export async function evictAllSessions(): Promise<number> {
  const keys = [...pool.keys()].filter((key) => !pool.get(key)?.promptInFlight);

  for (const key of keys) {
    await remove(key);
  }
  return keys.length;
}

/**
 * Clear the entire pool and dispose all agents (exported for testing).
 */
export async function clearPool(): Promise<void> {
  clearInterval(timer);
  poolGeneration++;
  pendingCreations.clear();
  for (const [, entry] of pool) {
    entry.session.dispose();
  }
  pool.clear();
  // Clean up all dispatchers and persistence
  for (const [sessionId] of dispatchers) {
    await clearSessionResources(sessionId);
  }
}

/**
 * Graceful shutdown. dispose all agents and clear the pool.
 * Call this during process shutdown to ensure clean resource release.
 */
export async function shutdown(): Promise<void> {
  clearInterval(timer);
  poolGeneration++;
  pendingCreations.clear();
  for (const [, entry] of pool) {
    entry.session.dispose();
  }
  pool.clear();
  // Clean up all dispatchers and persistence
  for (const [sessionId] of dispatchers) {
    await clearSessionResources(sessionId);
  }
}

// Periodic eviction. runs every 5 minutes
const timer = setInterval(
  () => {
    evictIdle().catch((err) => {
      console.error("[agent-pool] Eviction failed:", err);
    });
  },
  5 * 60 * 1000,
);
timer.unref(); // Don't keep process alive
