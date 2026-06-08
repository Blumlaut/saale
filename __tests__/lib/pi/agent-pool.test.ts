import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  getPoolKey,
  getSessionDir,
  createAndPool,
  get,
  remove,
  evictIdle,
  getPoolSize,
  getPoolKeys,
  clearPool,
  shutdown,
} from "@/lib/pi/agent-pool";

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
  beforeEach(() => {
    clearPool();
  });

  afterEach(() => {
    clearPool();
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
      await createAndPool("test-key", async () => ({
        session: asAgentSession(mockSession),
        sessionDir: "/tmp/test",
      }));

      remove("test-key");

      expect(getPoolSize()).toBe(0);
      expect(get("test-key")).toBeUndefined();
      expect(mockSession.dispose).toHaveBeenCalled();
    });

    it("is no-op for missing key", () => {
      expect(() => remove("nonexistent")).not.toThrow();
      expect(getPoolSize()).toBe(0);
    });
  });

  describe("evictIdle", () => {
    it("does not evict recently active sessions", async () => {
      const mockSession = createMockAgentSession();
      await createAndPool("test-key", async () => ({
        session: asAgentSession(mockSession),
        sessionDir: "/tmp/test",
      }));

      evictIdle();

      expect(getPoolSize()).toBe(1);
      expect(mockSession.dispose).not.toHaveBeenCalled();
    });

    it("does not evict streaming sessions even if idle", async () => {
      const mockSession = createMockAgentSession(true); // isStreaming = true
      const entry = await createAndPool("test-key", async () => ({
        session: asAgentSession(mockSession),
        sessionDir: "/tmp/test",
      }));

      // Manually set lastActive to 1 hour ago (beyond MAX_IDLE_MS of 30min)
      entry.lastActive = Date.now() - 60 * 60 * 1000;

      evictIdle();

      expect(getPoolSize()).toBe(1);
      expect(mockSession.dispose).not.toHaveBeenCalled();
    });

    it("evicts idle non-streaming sessions", async () => {
      const mockSession = createMockAgentSession(false); // isStreaming = false
      const entry = await createAndPool("test-key", async () => ({
        session: asAgentSession(mockSession),
        sessionDir: "/tmp/test",
      }));

      // Manually set lastActive to 1 hour ago (beyond MAX_IDLE_MS of 30min)
      entry.lastActive = Date.now() - 60 * 60 * 1000;

      evictIdle();

      expect(getPoolSize()).toBe(0);
      expect(mockSession.dispose).toHaveBeenCalled();
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

      await createAndPool("key-1", async () => ({
        session: asAgentSession(session1),
        sessionDir: "/tmp/1",
      }));
      await createAndPool("key-2", async () => ({
        session: asAgentSession(session2),
        sessionDir: "/tmp/2",
      }));

      shutdown();

      expect(getPoolSize()).toBe(0);
      expect(session1.dispose).toHaveBeenCalled();
      expect(session2.dispose).toHaveBeenCalled();
    });
  });
});
