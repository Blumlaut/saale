import { describe, expect, it, vi, beforeEach } from "vitest";

const { mockGet, mockRemove, mockMarkRebuildPending } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockRemove: vi.fn(),
  mockMarkRebuildPending: vi.fn(),
}));

vi.mock("@/lib/pi/agent-pool", () => ({
  get: mockGet,
  getPoolKey: (userId: string, sessionId: string) => `${userId}:${sessionId}`,
  remove: mockRemove,
  markRebuildPending: mockMarkRebuildPending,
}));

import { syncPooledAgentSession } from "@/lib/pi/sync-pooled-session";

/**
 * A settings change has to reach the live agent session, and the system prompt
 * names the model in the commit trailer. So the session is rebuilt rather than
 * patched, and never while a run is in flight.
 */

const settings = {
  modelProvider: "anthropic",
  modelName: "claude-sonnet-4-5",
  thinkingLevel: "medium",
  toolConfig: { terminal: true },
};

function pooled(isStreaming = false, promptInFlight = false) {
  mockGet.mockReturnValue({ session: { isStreaming }, promptInFlight });
}

const sync = (updated: Partial<typeof settings>) =>
  syncPooledAgentSession({
    userId: "user-1",
    sessionId: "chat-1",
    previous: settings,
    updated: { ...settings, ...updated },
  });

describe("syncPooledAgentSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rebuilds the session when the model changes", async () => {
    pooled();

    await sync({ modelName: "claude-opus-4-1" });

    expect(mockRemove).toHaveBeenCalledWith("user-1:chat-1");
    expect(mockMarkRebuildPending).not.toHaveBeenCalled();
  });

  it("rebuilds the session when the thinking level or tool config changes", async () => {
    pooled();

    await sync({ thinkingLevel: "high" });
    await sync({ toolConfig: { terminal: false } });

    expect(mockRemove).toHaveBeenCalledTimes(2);
  });

  it("leaves the session alone when nothing changed", async () => {
    pooled();

    await sync({});

    expect(mockRemove).not.toHaveBeenCalled();
    expect(mockMarkRebuildPending).not.toHaveBeenCalled();
  });

  it("marks the session while a run is in flight instead of aborting it", async () => {
    pooled(true);

    await sync({ modelName: "claude-opus-4-1" });

    expect(mockMarkRebuildPending).toHaveBeenCalledWith("user-1:chat-1");
    expect(mockRemove).not.toHaveBeenCalled();
  });

  it("does nothing while the chat has no pooled session", async () => {
    mockGet.mockReturnValue(undefined);

    await sync({ modelName: "claude-opus-4-1" });

    expect(mockRemove).not.toHaveBeenCalled();
  });
});
