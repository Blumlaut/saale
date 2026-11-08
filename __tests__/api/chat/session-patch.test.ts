import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * PATCH /api/chat/sessions/:id must reach the chat's live agent session.
 *
 * The pool holds one AgentSession per chat whose model, thinking level, tool
 * loadout and system prompt are fixed when it is built. Writing only to the
 * database left the running session on the old settings until eviction  up to
 * 30 minutes  so a user who switched models kept getting answers from the
 * previous one.
 */

const {
  mockRequireChatSessionOwner,
  mockUpdate,
  mockFindUnique,
  mockGetPooledSession,
  mockRemove,
  mockGetPoolKey,
  mockMarkRebuildPending,
} = vi.hoisted(() => ({
  mockRequireChatSessionOwner: vi.fn(),
  mockUpdate: vi.fn(),
  mockFindUnique: vi.fn(),
  mockGetPooledSession: vi.fn(),
  mockRemove: vi.fn(),
  mockGetPoolKey: (userId: string, sessionId: string) => `${userId}:${sessionId}`,
  mockMarkRebuildPending: vi.fn(),
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
  markRebuildPending: mockMarkRebuildPending,
  getSessionDir: (userId: string, sessionId: string) =>
    `/tmp/uploads/pi_sessions/${userId}/${sessionId}`,
}));

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
  it("drops the pooled session when the model changes", async () => {
    mockGetPooledSession.mockReturnValue({ session: makeSession() });

    const res = await patch({ modelProvider: "openai", modelName: "gpt-6" });

    expect(res.status).toBe(200);
    expect(mockRemove).toHaveBeenCalledWith(`${USER_ID}:${SESSION_ID}`);
  });

  it("drops the pooled session when the thinking level changes", async () => {
    mockGetPooledSession.mockReturnValue({ session: makeSession() });

    await patch({ thinkingLevel: "high" });

    expect(mockRemove).toHaveBeenCalledWith(`${USER_ID}:${SESSION_ID}`);
  });

  it("drops the pooled session when the level goes back to Pi's own", async () => {
    // "default" is a stored setting rather than a level, so the rebuild is what
    // hands Pi no opinion at all.
    mockGetPooledSession.mockReturnValue({ session: makeSession() });

    await patch({ thinkingLevel: "default" });

    expect(mockRemove).toHaveBeenCalledWith(`${USER_ID}:${SESSION_ID}`);
  });

  it("drops the pooled session when the tool loadout changes", async () => {
    mockGetPooledSession.mockReturnValue({ session: makeSession() });

    await patch({ toolConfig: { terminal: false, memory: true } });

    expect(mockRemove).toHaveBeenCalledWith(`${USER_ID}:${SESSION_ID}`);
  });

  it("never drops a session that is mid-run", async () => {
    // Disposal would abort the run and drop every connected client's stream, so
    // the session is marked and the eviction pass rebuilds it.
    mockGetPooledSession.mockReturnValue({ session: makeSession({ isStreaming: true }) });

    await patch({ modelProvider: "openai", modelName: "gpt-6" });

    expect(mockRemove).not.toHaveBeenCalled();
    expect(mockMarkRebuildPending).toHaveBeenCalledWith(`${USER_ID}:${SESSION_ID}`);
  });

  it("leaves the pool alone for a change that touches nothing", async () => {
    mockGetPooledSession.mockReturnValue({ session: makeSession() });

    await patch({ title: "Renamed" });

    expect(mockRemove).not.toHaveBeenCalled();
    expect(mockMarkRebuildPending).not.toHaveBeenCalled();
  });

  it("does nothing when the chat has no pooled session", async () => {
    mockGetPooledSession.mockReturnValue(undefined);

    const res = await patch({ modelProvider: "openai", modelName: "gpt-6" });

    expect(res.status).toBe(200);
    expect(mockRemove).not.toHaveBeenCalled();
    expect(mockMarkRebuildPending).not.toHaveBeenCalled();
  });
});

describe("PATCH session  pinning", () => {
  it("stores a pin without counting it as activity", async () => {
    const res = await patch({ pinned: true });

    expect(res.status).toBe(200);
    const data = (mockUpdate.mock.calls[0]![0] as { data: Record<string, unknown> }).data;
    expect(data.pinned).toBe(true);
    // A pin moves the row to the top of the list, so the recency stamp must stay.
    expect(data.lastActivityAt).toBeUndefined();
    expect(await res.json()).toMatchObject({ session: { pinned: true } });
  });

  it("still stamps the activity time when the same request changes more", async () => {
    await patch({ pinned: true, title: "Renamed" });

    const data = (mockUpdate.mock.calls[0]![0] as { data: Record<string, unknown> }).data;
    expect(data.pinned).toBe(true);
    expect(data.lastActivityAt).toBeInstanceOf(Date);
  });

  it("writes nothing when the pin is already what was asked for", async () => {
    mockRequireChatSessionOwner.mockResolvedValue({
      ok: true,
      userId: USER_ID,
      session: { ...STORED, pinned: true },
    });

    await patch({ pinned: true });

    expect(mockUpdate).not.toHaveBeenCalled();
  });
});
