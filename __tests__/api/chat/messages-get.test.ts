import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ─── Mocks ───────────────────────────────────────────────────────────────────

const {
  mockRequireChatSessionOwner,
  mockPrisma,
  mockIsSessionActive,
  mockIsAgentBuilding,
  mockResolveModelForPurpose,
} = vi.hoisted(() => ({
  mockRequireChatSessionOwner: vi.fn(),
  mockPrisma: {
    chatMessage: { findMany: vi.fn(), findFirst: vi.fn() },
  },
  mockIsSessionActive: vi.fn().mockResolvedValue(false),
  mockIsAgentBuilding: vi.fn().mockResolvedValue(false),
  mockResolveModelForPurpose: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  requireChatSessionOwner: mockRequireChatSessionOwner,
}));

vi.mock("@/lib/db", () => ({ prisma: mockPrisma }));

vi.mock("@/lib/pi/model-resolution", () => ({
  resolveModelForPurpose: mockResolveModelForPurpose,
}));

vi.mock("@/lib/redis", () => ({
  isAgentBuilding: mockIsAgentBuilding,
  isSessionActive: mockIsSessionActive,
  isSendQueueHeld: vi.fn().mockResolvedValue(false),
}));

import { GET } from "@/app/api/chat/sessions/[sessionId]/messages/route";

const SESSION_ID = "session-1";
const USER_ID = "user-1";

function baseMessage(overrides: Record<string, unknown>) {
  return {
    id: "msg-1",
    sessionId: SESSION_ID,
    role: "assistant",
    content: "",
    thinking: null,
    toolCalls: null,
    errorMessage: null,
    parentMessageId: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    attachments: [],
    ...overrides,
  };
}

function baseSession(overrides: Record<string, unknown> = {}) {
  return {
    id: SESSION_ID,
    temporary: false,
    modelProvider: "openai",
    modelName: "gpt-5",
    thinkingLevel: "default",
    toolConfig: null,
    activeToolCallId: null,
    activeToolName: null,
    activeToolArgs: null,
    activeToolStartedAt: null,
    ...overrides,
  };
}

async function get(query = "") {
  const res = await GET(
    new NextRequest(`http://localhost/api/chat/sessions/${SESSION_ID}/messages${query}`),
    { params: Promise.resolve({ sessionId: SESSION_ID }) },
  );
  return res;
}
beforeEach(() => {
  vi.clearAllMocks();
  mockRequireChatSessionOwner.mockResolvedValue({
    ok: true,
    userId: USER_ID,
    session: baseSession(),
  });
  mockIsSessionActive.mockResolvedValue(false);
  mockIsAgentBuilding.mockResolvedValue(false);
  mockResolveModelForPurpose.mockResolvedValue(undefined);
});

describe("GET /api/chat/sessions/[sessionId]/messages", () => {
  it("names the model a chat without one of its own falls back to", async () => {
    mockRequireChatSessionOwner.mockResolvedValue({
      ok: true,
      userId: USER_ID,
      session: baseSession({ modelProvider: null, modelName: null }),
    });
    mockResolveModelForPurpose.mockResolvedValue({
      provider: "anthropic",
      name: "claude-sonnet-4",
    });
    mockPrisma.chatMessage.findMany.mockResolvedValue([]);

    const body = await (await get()).json();

    // The header says what will answer instead of an empty picker.
    expect(body.session.defaultModel).toEqual({ provider: "anthropic", name: "claude-sonnet-4" });
    expect(mockResolveModelForPurpose).toHaveBeenCalledWith(USER_ID, "chat");
  });

  it("reports no default when nothing resolves, so the header says so", async () => {
    mockRequireChatSessionOwner.mockResolvedValue({
      ok: true,
      userId: USER_ID,
      session: baseSession({ modelProvider: null, modelName: null }),
    });
    mockPrisma.chatMessage.findMany.mockResolvedValue([]);

    const body = await (await get()).json();

    expect(body.session.defaultModel).toBeNull();
  });

  it("leaves a chat's own model alone", async () => {
    mockPrisma.chatMessage.findMany.mockResolvedValue([]);

    const body = await (await get()).json();

    expect(body.session.defaultModel).toBeNull();
    expect(mockResolveModelForPurpose).not.toHaveBeenCalled();
  });

  it("returns the provider error of a failed assistant turn", async () => {
    // The route reads a page newest-first and answers in transcript order.
    mockPrisma.chatMessage.findMany.mockResolvedValue([
      baseMessage({ errorMessage: '400: {"message":"Invalid max_tokens value"}' }),
      baseMessage({ id: "u1", role: "user", content: "hi" }),
    ]);

    const body = await (await get()).json();

    // The failed turn is delivered with its error and no content  the UI has
    // nothing else to show for it.
    expect(body.messages[1]).toMatchObject({
      id: "msg-1",
      role: "assistant",
      content: "",
      errorMessage: '400: {"message":"Invalid max_tokens value"}',
    });
    expect(body.messages[0].errorMessage).toBeUndefined();
  });

  it("omits errorMessage for turns that did not fail", async () => {
    mockPrisma.chatMessage.findMany.mockResolvedValue([baseMessage({ content: "All good" })]);

    const body = await (await get()).json();

    expect(body.messages[0].content).toBe("All good");
    expect(body.messages[0].errorMessage).toBeUndefined();
  });

  it("keeps the error alongside partial text from a mid-stream failure", async () => {
    mockPrisma.chatMessage.findMany.mockResolvedValue([
      baseMessage({
        content: "Here is the first half",
        errorMessage: "503: service unavailable",
        thinking: "reasoning so far",
      }),
    ]);

    const body = await (await get()).json();

    expect(body.messages[0]).toMatchObject({
      content: "Here is the first half",
      thinking: "reasoning so far",
      errorMessage: "503: service unavailable",
    });
  });

  it("reports a workspace that is still being built", async () => {
    mockPrisma.chatMessage.findMany
      .mockResolvedValueOnce([baseMessage({ id: "u1", role: "user", content: "hi" })])
      .mockResolvedValueOnce([]);
    mockIsAgentBuilding.mockResolvedValue(true);

    const body = await (await get()).json();

    // Nothing streams while the build runs, so a client that comes back to the
    // chat needs this to know a reply is still owed.
    expect(body.session.isBuilding).toBe(true);
    expect(body.session.isGenerating).toBe(false);
  });

  it("reports the send queue separately from the conversation", async () => {
    const queuedAt = new Date("2026-01-01T00:01:00Z");
    mockPrisma.chatMessage.findMany
      .mockResolvedValueOnce([baseMessage({ id: "answered", role: "assistant" })])
      .mockResolvedValueOnce([
        baseMessage({ id: "queued-1", role: "user", content: "not yet", queuedAt }),
      ]);

    const body = await (await get()).json();

    // Queued messages never mix into the conversation, and they are not
    // filtered out of the conversation by the client either.
    expect(body.messages.map((m: { id: string }) => m.id)).toEqual(["answered"]);
    expect(body.queuedMessages.map((m: { id: string }) => m.id)).toEqual(["queued-1"]);
    expect(body.queuedMessages[0].content).toBe("not yet");

    // The conversation query excludes them in the database, not in the client.
    expect(mockPrisma.chatMessage.findMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ where: { sessionId: SESSION_ID, queuedAt: null } }),
    );
    expect(mockPrisma.chatMessage.findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: { sessionId: SESSION_ID, queuedAt: { not: null } },
        orderBy: { queuedAt: "asc" },
      }),
    );
  });

  it("answers with one page of a long conversation and says more exist", async () => {
    const newestFirst = Array.from({ length: 61 }, (_, index) =>
      baseMessage({
        id: `msg-${61 - index}`,
        role: "user",
        content: `m${61 - index}`,
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 61 - index)),
      }),
    );
    mockPrisma.chatMessage.findMany.mockResolvedValue(newestFirst);

    const body = await (await get()).json();

    // 60 on screen, the 61st is the signal that a page of older turns waits.
    expect(body.messages).toHaveLength(60);
    expect(body.hasEarlier).toBe(true);
    // Transcript order: oldest of the page first.
    expect(body.messages[0].id).toBe("msg-2");
    expect(body.messages[59].id).toBe("msg-61");
    expect(mockPrisma.chatMessage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 61, orderBy: [{ createdAt: "desc" }, { id: "desc" }] }),
    );
  });

  it("reads the page before the oldest message on screen", async () => {
    const cursor = { id: "msg-10", createdAt: new Date("2026-01-01T00:00:10Z") };
    mockPrisma.chatMessage.findFirst.mockResolvedValue(cursor);
    mockPrisma.chatMessage.findMany.mockResolvedValue([
      baseMessage({ id: "msg-9", createdAt: new Date("2026-01-01T00:00:09Z") }),
      baseMessage({ id: "msg-8", createdAt: new Date("2026-01-01T00:00:08Z") }),
    ]);

    const body = await (await get("?before=msg-10")).json();

    expect(body.hasEarlier).toBe(false);
    expect(body.messages.map((m: { id: string }) => m.id)).toEqual(["msg-8", "msg-9"]);
    expect(mockPrisma.chatMessage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          sessionId: SESSION_ID,
          queuedAt: null,
          OR: [
            { createdAt: { lt: cursor.createdAt } },
            { createdAt: cursor.createdAt, id: { lt: "msg-10" } },
          ],
        },
      }),
    );
  });

  it("refuses a cursor from another conversation", async () => {
    mockPrisma.chatMessage.findFirst.mockResolvedValue(null);

    const response = await get("?before=someone-elses-message");

    expect(response.status).toBe(400);
    // A bad cursor never becomes a query for the conversation (the send queue
    // is read regardless).
    expect(mockPrisma.chatMessage.findMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ take: expect.any(Number) }),
    );
  });
});
