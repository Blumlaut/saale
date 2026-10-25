import { describe, expect, it, vi } from "vitest";

const { mockGet } = vi.hoisted(() => ({ mockGet: vi.fn() }));

vi.mock("@/lib/pi/agent-pool", () => ({
  get: mockGet,
  getPoolKey: (userId: string, sessionId: string) => `${userId}:${sessionId}`,
}));

import { sessionEnvVars } from "@/lib/pi/session-env";

describe("sessionEnvVars", () => {
  it("names the chat and the model answering in it", () => {
    mockGet.mockReturnValue({
      session: {
        model: { id: "claude-sonnet-4-5", provider: "anthropic" },
        thinkingLevel: "medium",
      },
    });

    expect(sessionEnvVars("user-1", "chat-1")).toEqual({
      SAALE_CHAT_ID: "chat-1",
      SAALE_MODEL: "claude-sonnet-4-5",
      SAALE_MODEL_PROVIDER: "anthropic",
      SAALE_THINKING_LEVEL: "medium",
    });
    // The pool is keyed by both halves: a chat id alone must not reach another user's session.
    expect(mockGet).toHaveBeenCalledWith("user-1:chat-1");
  });

  it("only names the chat while no session is pooled", () => {
    mockGet.mockReturnValue(undefined);

    expect(sessionEnvVars("user-1", "chat-1")).toEqual({ SAALE_CHAT_ID: "chat-1" });
  });

  it("leaves the model out while the session has none selected", () => {
    mockGet.mockReturnValue({ session: { model: undefined, thinkingLevel: "off" } });

    expect(sessionEnvVars("user-1", "chat-1")).toEqual({
      SAALE_CHAT_ID: "chat-1",
      SAALE_THINKING_LEVEL: "off",
    });
  });
});
