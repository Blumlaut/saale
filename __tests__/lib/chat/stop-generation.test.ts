import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Stop must reach every run that is in flight, not only one that happens to be
 * inside the agent loop at the moment it is pressed. A prompt deferred to a
 * compaction (or a run the pool has claimed but not started) has
 * `promptInFlight` set while `isStreaming` is false — gating the abort on
 * `isStreaming` left those runs untouched, so Stop looked like a no-op.
 */

const mockIsSessionActive = vi.fn();
const mockUnregister = vi.fn();
const mockHoldSendQueue = vi.fn();
vi.mock("@/lib/redis", () => ({
  isSessionActive: (...args: unknown[]) => mockIsSessionActive(...args),
  unregisterActiveSession: (...args: unknown[]) => mockUnregister(...args),
  holdSendQueue: (...args: unknown[]) => mockHoldSendQueue(...args),
}));

const mockGet = vi.fn();
vi.mock("@/lib/pi/agent-pool", () => ({
  getPoolKey: (userId: string, sessionId: string) => `${userId}:${sessionId}`,
  get: (...args: unknown[]) => mockGet(...args),
}));

const mockRequestAbort = vi.fn();
vi.mock("@/lib/pi/abort-request", () => ({
  requestSessionAbort: (...args: unknown[]) => mockRequestAbort(...args),
}));

import { stopChatGeneration } from "@/lib/chat/stop-generation";

const USER_ID = "user-1";
const SESSION_ID = "chat-1";

function pooled(options: { streaming: boolean; promptInFlight: boolean }) {
  return {
    promptInFlight: options.promptInFlight,
    session: {
      isStreaming: options.streaming,
      abort: vi.fn().mockResolvedValue(undefined),
    },
  };
}

describe("stopChatGeneration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUnregister.mockResolvedValue(undefined);
    mockHoldSendQueue.mockResolvedValue(undefined);
  });

  it("reports false when no run is active anywhere", async () => {
    mockIsSessionActive.mockResolvedValue(false);
    mockGet.mockReturnValue(undefined);

    await expect(stopChatGeneration(USER_ID, SESSION_ID)).resolves.toBe(false);
    expect(mockHoldSendQueue).not.toHaveBeenCalled();
    expect(mockUnregister).not.toHaveBeenCalled();
  });

  it("aborts a run that is claimed but not yet inside the agent loop", async () => {
    mockIsSessionActive.mockResolvedValue(true);
    const entry = pooled({ streaming: false, promptInFlight: true });
    mockGet.mockReturnValue(entry);

    await expect(stopChatGeneration(USER_ID, SESSION_ID)).resolves.toBe(true);

    expect(mockRequestAbort).toHaveBeenCalledWith(USER_ID, SESSION_ID);
    expect(entry.session.abort).toHaveBeenCalled();
    expect(mockUnregister).toHaveBeenCalledWith(USER_ID, SESSION_ID);
  });

  it("aborts a streaming run and pauses the send queue", async () => {
    mockIsSessionActive.mockResolvedValue(true);
    const entry = pooled({ streaming: true, promptInFlight: true });
    mockGet.mockReturnValue(entry);

    await expect(stopChatGeneration(USER_ID, SESSION_ID)).resolves.toBe(true);

    expect(mockHoldSendQueue).toHaveBeenCalledWith(SESSION_ID);
    expect(entry.session.abort).toHaveBeenCalled();
    expect(mockUnregister).toHaveBeenCalledWith(USER_ID, SESSION_ID);
  });

  it("still clears the flag when the run is only known through Redis", async () => {
    // The run lives in another process, so there is no local session to abort —
    // but Stop must not silently do nothing.
    mockIsSessionActive.mockResolvedValue(true);
    mockGet.mockReturnValue(undefined);

    await expect(stopChatGeneration(USER_ID, SESSION_ID)).resolves.toBe(true);
    expect(mockUnregister).toHaveBeenCalledWith(USER_ID, SESSION_ID);
  });
});
