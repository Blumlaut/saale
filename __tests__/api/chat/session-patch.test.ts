import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * PATCH /api/chat/sessions/:id must reach the chat's live agent session.
 *
 * The pool holds one AgentSession per chat whose model, thinking level and tool
 * loadout are fixed when it is built. Writing only to the database left the
 * running session on the old settings until eviction  up to 30 minutes  so a
 * user who switched models kept getting answers from the previous one.
 */

const {
  mockRequireChatSessionOwner,
  mockUpdate,
  mockFindUnique,
  mockGetPooledSession,
  mockRemove,
  mockGetPoolKey,
  mockBuildModelRuntime,
} = vi.hoisted(() => ({
  mockRequireChatSessionOwner: vi.fn(),
  mockUpdate: vi.fn(),
  mockFindUnique: vi.fn(),
  mockGetPooledSession: vi.fn(),
  mockRemove: vi.fn(),
  mockGetPoolKey: (userId: string, sessionId: string) => `${userId}:${sessionId}`,
  mockBuildModelRuntime: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ requireChatSessionOwner: mockRequireChatSessionOwner }));

vi.mock("@/lib/db", () => ({
  prisma: {
    chatSession: { update: mockUpdate },
    chatMessage: { findMany: mockFindUnique },
  },
}));

vi.mock("@/lib/pi/agent-pool", () => ({
  get: mockGetPooledSession,
  remove: mockRemove,
  getPoolKey: mockGetPoolKey,
  getSessionDir: (userId: string, sessionId: string) =>
    `/tmp/uploads/pi_sessions/${userId}/${sessionId}`,
}));

vi.mock("@/lib/pi/models", () => ({ buildModelRuntime: mockBuildModelRuntime }));

vi.mock("@/lib/image-attachment", () => ({
  deleteAllImages: vi.fn().mockResolvedValue(undefined),
}));

import { PATCH } from "@/app/api/chat/sessions/[sessionId]/route";

const USER_ID = "user-1";
const SESSION_ID = "chat-1";

const STORED = {
  id: SESSION_ID,
  title: "Chat",
  modelProvider: "anthropic",
  modelName: "claude-sonnet-4-5",
  thinkingLevel: "medium",
  toolConfig: { terminal: true, memory: true },
};

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    isStreaming: false,
    promptInFlight: false,
    setModel: vi.fn().mockResolvedValue(undefined),
    setThinkingLevel: vi.fn(),
    ...overrides,
  };
}

function patch(body: Record<string, unknown>) {
  return PATCH(
    new NextRequest(`http://localhost/api/chat/sessions/${SESSION_ID}`, {
      method: "PATCH",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    }),
    { params: Promise.resolve({ sessionId: SESSION_ID }) },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireChatSessionOwner.mockResolvedValue({ ok: true, userId: USER_ID, session: STORED });
  mockUpdate.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
    Promise.resolve({ ...STORED, ...data }),
  );
  mockGetPooledSession.mockReturnValue(undefined);
  mockRemove.mockResolvedValue(undefined);
});

describe("PATCH session  live agent session", () => {
  it("switches the model on the pooled agent session", async () => {
    const session = makeSession();
    mockGetPooledSession.mockReturnValue({ session });
    const model = { provider: "openai", id: "gpt-6" };
    mockBuildModelRuntime.mockResolvedValue({
      modelRuntime: { getModel: vi.fn().mockReturnValue(model) },
    });

    const res = await patch({ modelProvider: "openai", modelName: "gpt-6" });

    expect(res.status).toBe(200);
    expect(session.setModel).toHaveBeenCalledWith(model);
  });

  it("applies a thinking-level change", async () => {
    const session = makeSession();
    mockGetPooledSession.mockReturnValue({ session });

    await patch({ thinkingLevel: "high" });

    expect(session.setThinkingLevel).toHaveBeenCalledWith("high");
  });

  it("leaves the agent alone for Saale's 'default' level", async () => {
    const session = makeSession();
    mockGetPooledSession.mockReturnValue({ session });

    await patch({ thinkingLevel: "default" });

    expect(session.setThinkingLevel).not.toHaveBeenCalled();
  });

  it("drops the pooled session when the tool loadout changes", async () => {
    // Tools are resolved from the config when the session is built, so the
    // loadout cannot be changed in place  the next message rebuilds it.
    const session = makeSession();
    mockGetPooledSession.mockReturnValue({ session });

    await patch({ toolConfig: { terminal: false, memory: true } });

    expect(mockRemove).toHaveBeenCalledWith(`${USER_ID}:${SESSION_ID}`);
    expect(session.setModel).not.toHaveBeenCalled();
  });

  it("never drops a session that is mid-run", async () => {
    const session = makeSession({ isStreaming: true });
    mockGetPooledSession.mockReturnValue({ session });

    await patch({ toolConfig: { terminal: false, memory: true } });

    expect(mockRemove).not.toHaveBeenCalled();
  });

  it("does nothing when the chat has no pooled session", async () => {
    mockGetPooledSession.mockReturnValue(undefined);

    const res = await patch({ modelProvider: "openai", modelName: "gpt-6" });

    expect(res.status).toBe(200);
    expect(mockBuildModelRuntime).not.toHaveBeenCalled();
  });
});
