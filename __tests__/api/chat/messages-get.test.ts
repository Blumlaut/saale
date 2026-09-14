import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ─── Mocks ───────────────────────────────────────────────────────────────────

const { mockRequireChatSessionOwner, mockPrisma, mockIsSessionActive } = vi.hoisted(() => ({
  mockRequireChatSessionOwner: vi.fn(),
  mockPrisma: {
    chatMessage: { findMany: vi.fn() },
  },
  mockIsSessionActive: vi.fn().mockResolvedValue(false),
}));

vi.mock("@/lib/auth", () => ({
  requireChatSessionOwner: mockRequireChatSessionOwner,
}));

vi.mock("@/lib/db", () => ({ prisma: mockPrisma }));

vi.mock("@/lib/redis", () => ({
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

async function get() {
  const res = await GET(
    new NextRequest(`http://localhost/api/chat/sessions/${SESSION_ID}/messages`),
    { params: Promise.resolve({ sessionId: SESSION_ID }) },
  );
  return res.json();
}
beforeEach(() => {
  vi.clearAllMocks();
  mockRequireChatSessionOwner.mockResolvedValue({
    ok: true,
    userId: USER_ID,
    session: {
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
    },
  });
  mockIsSessionActive.mockResolvedValue(false);
});

describe("GET /api/chat/sessions/[sessionId]/messages", () => {
  it("returns the provider error of a failed assistant turn", async () => {
    mockPrisma.chatMessage.findMany.mockResolvedValue([
      baseMessage({ id: "u1", role: "user", content: "hi" }),
      baseMessage({ errorMessage: '400: {"message":"Invalid max_tokens value"}' }),
    ]);

    const body = await get();

    // The failed turn is delivered with its error and no content — the UI has
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

    const body = await get();

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

    const body = await get();

    expect(body.messages[0]).toMatchObject({
      content: "Here is the first half",
      thinking: "reasoning so far",
      errorMessage: "503: service unavailable",
    });
  });

  it("reports the send queue separately from the conversation", async () => {
    const queuedAt = new Date("2026-01-01T00:01:00Z");
    mockPrisma.chatMessage.findMany
      .mockResolvedValueOnce([baseMessage({ id: "answered", role: "assistant" })])
      .mockResolvedValueOnce([
        baseMessage({ id: "queued-1", role: "user", content: "not yet", queuedAt }),
      ]);

    const body = await get();

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
});
