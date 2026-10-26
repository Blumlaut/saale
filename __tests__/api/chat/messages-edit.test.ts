import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * PATCH /messages/:messageId rewrites history: the message is updated in place,
 * everything after it is deleted, and the next prompt regenerates the answer.
 *
 * Two handshakes leave this route for the stream connection that prompts the
 * edited message: the pending-prompt claim, and the history rewind that
 * truncates the agent's append-only transcript (without it the edited text is
 * appended after the deleted conversation and read as a brand new message).
 */

const {
  mockRequireSession,
  mockPrisma,
  mockTx,
  mockIsSessionActive,
  mockRegisterActiveSession,
  mockSetPendingPrompt,
  mockSetPendingHistoryRewind,
  mockReleaseSendQueue,
  mockGetPoolKey,
  mockGetPoolEntry,
} = vi.hoisted(() => ({
  mockRequireSession: vi.fn(),
  mockPrisma: {
    chatSession: { findFirst: vi.fn() },
    chatMessage: { findFirst: vi.fn(), findMany: vi.fn() },
    $transaction: vi.fn(),
  },
  mockTx: {
    chatMessage: { update: vi.fn(), deleteMany: vi.fn() },
  },
  mockIsSessionActive: vi.fn().mockResolvedValue(false),
  mockRegisterActiveSession: vi.fn().mockResolvedValue(undefined),
  mockSetPendingPrompt: vi.fn().mockResolvedValue(undefined),
  mockSetPendingHistoryRewind: vi.fn().mockResolvedValue(undefined),
  mockReleaseSendQueue: vi.fn().mockResolvedValue(undefined),
  mockGetPoolKey: vi.fn(() => "user-1:session-1"),
  mockGetPoolEntry: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ requireSession: mockRequireSession }));
vi.mock("@/lib/db", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/redis", () => ({
  isSessionActive: mockIsSessionActive,
  registerActiveSession: mockRegisterActiveSession,
  releaseSendQueue: mockReleaseSendQueue,
  setPendingPrompt: mockSetPendingPrompt,
  setPendingHistoryRewind: mockSetPendingHistoryRewind,
}));
vi.mock("@/lib/pi/agent-pool", () => ({
  get: mockGetPoolEntry,
  getPoolKey: mockGetPoolKey,
}));

import { PATCH } from "@/app/api/chat/sessions/[sessionId]/messages/[messageId]/route";

const SESSION_ID = "session-1";
const MESSAGE_ID = "msg-2";
const USER_ID = "user-1";

function storedMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: MESSAGE_ID,
    sessionId: SESSION_ID,
    role: "user",
    content: "the original text",
    createdAt: new Date("2026-01-01T00:05:00Z"),
    queuedAt: null,
    ...overrides,
  };
}

function patch(content: string) {
  return PATCH(
    new NextRequest(`http://localhost/api/chat/sessions/${SESSION_ID}/messages/${MESSAGE_ID}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    }),
    { params: Promise.resolve({ sessionId: SESSION_ID, messageId: MESSAGE_ID }) },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireSession.mockResolvedValue({ ok: true, user: { id: USER_ID } });
  mockPrisma.chatSession.findFirst.mockResolvedValue({ id: SESSION_ID });
  mockPrisma.chatMessage.findFirst.mockResolvedValue(storedMessage());
  // Two saved user messages; the edited one is the second.
  mockPrisma.chatMessage.findMany.mockResolvedValue([{ id: "msg-1" }, { id: MESSAGE_ID }]);
  mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockTx) => Promise<void>) =>
    fn(mockTx),
  );
  mockTx.chatMessage.update.mockResolvedValue({});
  mockTx.chatMessage.deleteMany.mockResolvedValue({ count: 0 });
  mockIsSessionActive.mockResolvedValue(false);
  mockGetPoolEntry.mockReturnValue(undefined);
});

describe("PATCH /messages/:messageId", () => {
  it("updates the message in place and deletes everything after it", async () => {
    const res = await patch("the edited text");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({
      ok: true,
      messageId: MESSAGE_ID,
      streamUrl: `/api/chat/sessions/${SESSION_ID}/stream`,
    });

    expect(mockTx.chatMessage.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: MESSAGE_ID },
        data: expect.objectContaining({ content: "the edited text", editedAt: expect.any(Date) }),
      }),
    );
    // Nothing is created  an edit must never add a message to the conversation.
    expect(mockTx.chatMessage.deleteMany).toHaveBeenCalledWith({
      where: { sessionId: SESSION_ID, createdAt: { gt: storedMessage().createdAt } },
    });
  });

  it("claims the prompt for the connection that will regenerate the answer", async () => {
    await patch("the edited text");

    expect(mockSetPendingPrompt).toHaveBeenCalledWith(SESSION_ID, MESSAGE_ID);
    expect(mockRegisterActiveSession).toHaveBeenCalledWith(USER_ID, SESSION_ID);
  });

  it("asks the prompt path to rewind the transcript past the deleted history", async () => {
    await patch("the edited text");

    expect(mockSetPendingHistoryRewind).toHaveBeenCalledWith(SESSION_ID, {
      messageId: MESSAGE_ID,
      previousContent: "the original text",
      userMessageIndex: 1,
    });
  });

  it("resumes a stopped session, so the edit is answered", async () => {
    // Stop holds the send queue, and the stream route refuses to prompt
    // anything while it is held. An edit asks for a new answer, so it has to
    // release the hold like sending does.
    await patch("the edited text");

    expect(mockReleaseSendQueue).toHaveBeenCalledWith(SESSION_ID);
    // Released before the connection can decide, which is what a held session
    // reads to refuse the prompt.
    expect(mockReleaseSendQueue.mock.invocationCallOrder[0]).toBeLessThan(
      mockRegisterActiveSession.mock.invocationCallOrder[0]!,
    );
  });

  it("rejects editing a message that is still queued", async () => {
    mockPrisma.chatMessage.findFirst.mockResolvedValue(storedMessage({ queuedAt: new Date() }));

    const res = await patch("the edited text");

    expect(res.status).toBe(409);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(mockSetPendingHistoryRewind).not.toHaveBeenCalled();
  });

  it("rejects editing an assistant message", async () => {
    mockPrisma.chatMessage.findFirst.mockResolvedValue(storedMessage({ role: "assistant" }));

    const res = await patch("the edited text");

    expect(res.status).toBe(400);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it("refuses to edit while a generation is running", async () => {
    mockIsSessionActive.mockResolvedValue(true);

    const res = await patch("the edited text");

    expect(res.status).toBe(409);
    expect(mockPrisma.chatMessage.findFirst).not.toHaveBeenCalled();
  });

  it("rejects empty content", async () => {
    const res = await patch("   ");

    expect(res.status).toBe(400);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });
});
