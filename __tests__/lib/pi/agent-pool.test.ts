import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  getPoolKey,
  getSessionDir,
  createAndPool,
  get,
  remove,
  evictIdle,
  getDispatcher,
  getPoolSize,
  getPoolKeys,
  shutdown,
} from "@/lib/pi/agent-pool";

// Mock Redis (used by SseDispatcher via sse-buffer)
const mockRedisIncr = vi.fn().mockResolvedValue(1);
const mockRedisExpire = vi.fn().mockResolvedValue(1);
const mockRedisZadd = vi.fn().mockResolvedValue(true);
const mockRedisZremrangebyrank = vi.fn().mockResolvedValue(0);
const mockRedisDel = vi.fn().mockResolvedValue(1);

vi.mock("@/lib/redis", () => ({
  getRedis: () => ({
    incr: mockRedisIncr,
    expire: mockRedisExpire,
    zadd: mockRedisZadd,
    zremrangebyrank: mockRedisZremrangebyrank,
    del: mockRedisDel,
  }),
}));

// Minimal mock matching only the properties the agent pool accesses
interface MockAgentSession {
  isStreaming: boolean;
  dispose: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
  prompt: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
  agent: {
    state: Record<string, never>;
    abort: ReturnType<typeof vi.fn>;
  };
}

function createMockAgentSession(isStreaming = false): MockAgentSession {
  return {
    isStreaming,
    dispose: vi.fn(),
    subscribe: vi.fn(),
    prompt: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),
    agent: { state: {}, abort: vi.fn().mockResolvedValue(undefined) },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Mock type cast for testing
const asAgentSession = (mock: MockAgentSession) => mock as any;

describe("agent-pool", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await shutdown();
  });

  afterEach(async () => {
    await shutdown();
  });

  describe("getPoolKey", () => {
    it("combines userId and sessionId with colon separator", () => {
      expect(getPoolKey("user-1", "session-abc")).toBe("user-1:session-abc");
    });

    it("handles special characters in IDs", () => {
      expect(getPoolKey("user@domain.com", "session:abc")).toBe("user@domain.com:session:abc");
    });
  });

  describe("getSessionDir", () => {
    it("builds correct path with default UPLOADS_DIR", () => {
      const original = process.env.UPLOADS_DIR;
      delete process.env.UPLOADS_DIR;
      const dir = getSessionDir("user-1", "session-abc");
      expect(dir).toMatch(/pi_sessions\/user-1\/session-abc$/);
      if (original !== undefined) {
        process.env.UPLOADS_DIR = original;
      }
    });

    it("uses UPLOADS_DIR env var when set", () => {
      const original = process.env.UPLOADS_DIR;
      process.env.UPLOADS_DIR = "/app/uploads";
      const dir = getSessionDir("user-1", "session-abc");
      expect(dir).toBe("/app/uploads/pi_sessions/user-1/session-abc");
      if (original !== undefined) {
        process.env.UPLOADS_DIR = original;
      }
    });
  });

  describe("createAndPool", () => {
    it("creates a new pooled session", async () => {
      const mockSession = createMockAgentSession();
      const sessionDir = "/tmp/test-session";

      const entry = await createAndPool("test-key", async () => ({
        session: asAgentSession(mockSession),
        sessionDir,
      }));

      expect(entry.session).toBe(mockSession);
      expect(entry.sessionDir).toBe(sessionDir);
      expect(entry.lastPromptedMessageId).toBeNull();
      expect(entry.lastActive).toBeGreaterThan(0);
      expect(getPoolSize()).toBe(1);
    });

    it("returns existing session without recreating", async () => {
      const mockSession = createMockAgentSession();
      await createAndPool("test-key", async () => ({
        session: asAgentSession(mockSession),
        sessionDir: "/tmp/test-session",
      }));

      const mockSession2 = createMockAgentSession();
      const entry = await createAndPool("test-key", async () => ({
        session: asAgentSession(mockSession2),
        sessionDir: "/tmp/other-session",
      }));

      // Should return the original session, not the new one
      expect(entry.session).toBe(mockSession);
      expect(entry.sessionDir).toBe("/tmp/test-session");
      expect(getPoolSize()).toBe(1);
    });

    it("updates lastActive on hit", async () => {
      await createAndPool("test-key", async () => ({
        session: asAgentSession(createMockAgentSession()),
        sessionDir: "/tmp/test",
      }));

      const first = get("test-key");
      expect(first).toBeDefined();
      const firstActive = first!.lastActive;

      await new Promise((resolve) => setTimeout(resolve, 10));

      const second = await createAndPool("test-key", async () => ({
        session: asAgentSession(createMockAgentSession()),
        sessionDir: "/tmp/other",
      }));

      expect(second.lastActive).toBeGreaterThan(firstActive);
    });

    it("shares one creation between concurrent callers", async () => {
      // Two requests for the same chat can overlap (a message sent while
      // /compact is still spinning up its session). Both must get the same
      // AgentSession  two live sessions over one transcript silently fork it.
      const mockSession = createMockAgentSession();
      let releaseCreation = () => {};
      const createFn = vi.fn(
        () =>
          new Promise<{ session: AgentSession; sessionDir: string }>((resolve) => {
            releaseCreation = () =>
              resolve({ session: asAgentSession(mockSession), sessionDir: "/tmp/shared" });
          }),
      );

      const first = createAndPool("test-key", createFn);
      const second = createAndPool("test-key", createFn);
      releaseCreation();
      const [a, b] = await Promise.all([first, second]);

      expect(createFn).toHaveBeenCalledTimes(1);
      expect(a.session).toBe(mockSession);
      expect(b).toBe(a);
      expect(getPoolSize()).toBe(1);
    });

    it("creates a new session after a teardown, not the one that was pending", async () => {
      const pendingSession = createMockAgentSession();
      let releaseCreation = () => {};
      const pending = createAndPool(
        "test-key",
        () =>
          new Promise<{ session: AgentSession; sessionDir: string }>((resolve) => {
            releaseCreation = () =>
              resolve({ session: asAgentSession(pendingSession), sessionDir: "/tmp/pending" });
          }),
      );

      await shutdown();
      releaseCreation();
      await pending;

      const freshSession = createMockAgentSession();
      const entry = await createAndPool("test-key", async () => ({
        session: asAgentSession(freshSession),
        sessionDir: "/tmp/fresh",
      }));

      expect(entry.session).toBe(freshSession);
      expect(getPoolSize()).toBe(1);
    });

    it("handles multiple sessions independently", async () => {
      const session1 = createMockAgentSession();
      const session2 = createMockAgentSession();

      await createAndPool("key-1", async () => ({
        session: asAgentSession(session1),
        sessionDir: "/tmp/1",
      }));
      await createAndPool("key-2", async () => ({
        session: asAgentSession(session2),
        sessionDir: "/tmp/2",
      }));

      expect(getPoolSize()).toBe(2);
      expect(get("key-1")!.session).toBe(session1);
      expect(get("key-2")!.session).toBe(session2);
    });
  });

  describe("get", () => {
    it("returns undefined for missing key", () => {
      expect(get("nonexistent")).toBeUndefined();
    });

    it("returns existing session", async () => {
      const mockSession = createMockAgentSession();
      await createAndPool("test-key", async () => ({
        session: asAgentSession(mockSession),
        sessionDir: "/tmp/test",
      }));

      const entry = get("test-key");
      expect(entry).toBeDefined();
      expect(entry!.session).toBe(mockSession);
    });

    it("updates lastActive", async () => {
      await createAndPool("test-key", async () => ({
        session: asAgentSession(createMockAgentSession()),
        sessionDir: "/tmp/test",
      }));

      const first = get("test-key")!;
      const firstActive = first.lastActive;

      await new Promise((resolve) => setTimeout(resolve, 10));

      const second = get("test-key")!;
      expect(second.lastActive).toBeGreaterThan(firstActive);
    });
  });

  describe("remove", () => {
    it("removes session and disposes agent", async () => {
      const mockSession = createMockAgentSession();
      // Pool key format: userId:sessionId
      const poolKey = "user-1:session-abc";
      const sessionId = "session-abc";
      await createAndPool(poolKey, async () => ({
        session: asAgentSession(mockSession),
        sessionDir: "/tmp/test",
      }));
      // Create dispatcher (as the stream route would)
      getDispatcher(sessionId);

      await remove(poolKey);

      expect(getPoolSize()).toBe(0);
      expect(get(poolKey)).toBeUndefined();
      expect(mockSession.dispose).toHaveBeenCalled();
      // The dispatcher is disposed WITHOUT touching Redis  the event buffer
      // is cleared per-generation (see resetSessionEvents), not on pool
      // removal, so Last-Event-ID reconnects keep working.
      expect(mockRedisDel).not.toHaveBeenCalled();
    });

    it("is no-op for missing key", async () => {
      await expect(remove("nonexistent")).resolves.toBeUndefined();
      expect(getPoolSize()).toBe(0);
    });
  });

  describe("evictIdle", () => {
    it("does not evict recently active sessions", async () => {
      const mockSession = createMockAgentSession();
      await createAndPool("user-1:session-abc", async () => ({
        session: asAgentSession(mockSession),
        sessionDir: "/tmp/test",
      }));

      await evictIdle();

      expect(getPoolSize()).toBe(1);
      expect(mockSession.dispose).not.toHaveBeenCalled();
    });

    it("does not evict streaming sessions even if idle", async () => {
      const mockSession = createMockAgentSession(true); // isStreaming = true
      const entry = await createAndPool("user-1:session-abc", async () => ({
        session: asAgentSession(mockSession),
        sessionDir: "/tmp/test",
      }));

      // Manually set lastActive to 1 hour ago (beyond MAX_IDLE_MS of 30min)
      entry.lastActive = Date.now() - 60 * 60 * 1000;

      await evictIdle();

      expect(getPoolSize()).toBe(1);
      expect(mockSession.dispose).not.toHaveBeenCalled();
    });

    // The hard cap exists to bound memory, but it must not cut a live
    // generation: disposing a streaming session aborts the run and drops every
    // connected client's stream.
    it("never evicts a streaming session to enforce the pool cap", async () => {
      const running = createMockAgentSession(true); // isStreaming = true
      const runningEntry = await createAndPool("user-1:running", async () => ({
        session: asAgentSession(running),
        sessionDir: "/tmp/running",
      }));
      // Oldest entry of all  a naive "evict the oldest" would pick it first.
      runningEntry.lastActive = 0;

      for (let i = 0; i < 101; i++) {
        await createAndPool(`user-${i}:session-${i}`, async () => ({
          session: asAgentSession(createMockAgentSession()),
          sessionDir: `/tmp/session-${i}`,
        }));
      }
      // createAndPool enforces the cap on the way in, so the pool never grows
      // past it  and the running session, the oldest entry of all, survives
      // every pass.
      await evictIdle();
      expect(running.dispose).not.toHaveBeenCalled();
      expect(getPoolKeys()).toContain("user-1:running");
      expect(getPoolSize()).toBeLessThanOrEqual(100);
    });

    it("evicts idle non-streaming sessions", async () => {
      const mockSession = createMockAgentSession(false); // isStreaming = false
      const poolKey = "user-1:session-abc";
      const sessionId = "session-abc";
      const entry = await createAndPool(poolKey, async () => ({
        session: asAgentSession(mockSession),
        sessionDir: "/tmp/test",
      }));
      // Create dispatcher (as the stream route would)
      getDispatcher(sessionId);

      // Manually set lastActive to 1 hour ago (beyond MAX_IDLE_MS of 30min)
      entry.lastActive = Date.now() - 60 * 60 * 1000;

      await evictIdle();

      expect(getPoolSize()).toBe(0);
      expect(mockSession.dispose).toHaveBeenCalled();
      // No Redis buffer cleanup on eviction (buffer is generation-scoped).
      expect(mockRedisDel).not.toHaveBeenCalled();
    });
  });

  describe("getPoolKeys", () => {
    it("returns all pool keys", async () => {
      await createAndPool("key-1", async () => ({
        session: asAgentSession(createMockAgentSession()),
        sessionDir: "/tmp/1",
      }));
      await createAndPool("key-2", async () => ({
        session: asAgentSession(createMockAgentSession()),
        sessionDir: "/tmp/2",
      }));

      const keys = getPoolKeys();
      expect(keys).toHaveLength(2);
      expect(keys).toContain("key-1");
      expect(keys).toContain("key-2");
    });

    it("returns empty array when pool is empty", () => {
      expect(getPoolKeys()).toEqual([]);
    });
  });

  describe("shutdown", () => {
    it("disposes all agents and clears pool", async () => {
      const session1 = createMockAgentSession();
      const session2 = createMockAgentSession();

      await createAndPool("user-1:session-1", async () => ({
        session: asAgentSession(session1),
        sessionDir: "/tmp/1",
      }));
      await createAndPool("user-2:session-2", async () => ({
        session: asAgentSession(session2),
        sessionDir: "/tmp/2",
      }));

      await shutdown();

      expect(getPoolSize()).toBe(0);
      expect(session1.dispose).toHaveBeenCalled();
      expect(session2.dispose).toHaveBeenCalled();
    });
  });
});
