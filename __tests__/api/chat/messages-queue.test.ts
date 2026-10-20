import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * POST /messages must never reject a message because the session is busy  it
 * queues it instead (the stream route drains the queue when the session is free
 * again). "Busy" covers a running generation and a manual compaction holding
 * the session. These tests pin the states apart: a queued message has
 * `queuedAt` set and claims no prompt, a normal message keeps the existing
 * pending-prompt handshake.
 */

const {
  mockRequireChatSessionOwner,
  mockPrisma,
  mockIsSessionActive,
  mockIsSessionBusy,
  mockRegisterActiveSession,
  mockSetPendingPrompt,
  mockPublishSessionEvent,
  mockReleaseSendQueue,
  mockIsSendQueueHeld,
  mockInterruptPendingApprovals,
} = vi.hoisted(() => ({
  mockRequireChatSessionOwner: vi.fn(),
  mockPrisma: {
    chatMessage: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
    },
    chatSession: { update: vi.fn() },
  },
  mockIsSessionActive: vi.fn(),
  mockIsSessionBusy: vi.fn(),
  mockRegisterActiveSession: vi.fn().mockResolvedValue(undefined),
  mockSetPendingPrompt: vi.fn().mockResolvedValue(undefined),
  mockPublishSessionEvent: vi.fn().mockResolvedValue(1),
  mockReleaseSendQueue: vi.fn().mockResolvedValue(undefined),
  mockIsSendQueueHeld: vi.fn().mockResolvedValue(false),
  mockInterruptPendingApprovals: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/auth", () => ({ requireChatSessionOwner: mockRequireChatSessionOwner }));
vi.mock("@/lib/db", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/redis", () => ({
  isSessionActive: mockIsSessionActive,
  isSessionBusy: mockIsSessionBusy,
  registerActiveSession: mockRegisterActiveSession,
  setPendingPrompt: mockSetPendingPrompt,
  releaseSendQueue: mockReleaseSendQueue,
  isSendQueueHeld: mockIsSendQueueHeld,
}));
vi.mock("@/lib/image-attachment", () => ({
  deleteAllImages: vi.fn(),
  processAndStoreImage: vi.fn(),
  readImageAsBase64: vi.fn(),
}));
vi.mock("@/lib/terminal/client", () => ({
  isConfigured: vi.fn(() => false),
  uploadFile: vi.fn(),
}));
vi.mock("@/lib/pi/session-events", () => ({
  publishSessionEvent: mockPublishSessionEvent,
}));
vi.mock("@/lib/chat/approval-interrupt", () => ({
  interruptPendingApprovals: mockInterruptPendingApprovals,
}));

import { POST } from "@/app/api/chat/sessions/[sessionId]/messages/route";
import { MAX_QUEUED_MESSAGES } from "@/lib/chat/queue";

const SESSION_ID = "session-1";
const USER_ID = "user-1";

function postMessage(content: string) {
  return POST(
    new NextRequest(`http://localhost/api/chat/sessions/${SESSION_ID}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    }),
    { params: Promise.resolve({ sessionId: SESSION_ID }) },
  );
}

/** A stored row as Prisma would return it. */
function storedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "msg-1",
    sessionId: SESSION_ID,
    role: "user",
    content: "hello",
    thinking: null,
    toolCalls: null,
    errorMessage: null,
    parentMessageId: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    editedAt: null,
    queuedAt: null,
    attachments: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireChatSessionOwner.mockResolvedValue({
    ok: true,
    userId: USER_ID,
    session: { id: SESSION_ID, title: "New Chat", toolConfig: {}, thinkingLevel: "default" },
  });
  mockPrisma.chatMessage.count.mockResolvedValue(0);
  mockPrisma.chatMessage.create.mockResolvedValue({ id: "msg-1" });
  mockPrisma.chatSession.update.mockResolvedValue({});
  mockIsSessionBusy.mockResolvedValue(false);
  mockInterruptPendingApprovals.mockResolvedValue(null);
});

describe("POST /messages while a generation is running", () => {
  beforeEach(() => {
    mockIsSessionActive.mockResolvedValue(true);
    mockIsSessionBusy.mockResolvedValue(true);
  });

  it("queues the message instead of rejecting it", async () => {
    mockPrisma.chatMessage.findUnique.mockResolvedValue(storedRow({ queuedAt: new Date() }));

    const res = await postMessage("hello");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.queued).toBe(true);
    expect(body.message.id).toBe("msg-1");

    // Stored with queuedAt set  that is what keeps it out of the conversation
    // until the drain delivers it.
    expect(mockPrisma.chatMessage.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ queuedAt: expect.any(Date), role: "user" }),
      }),
    );

    // A queued message must not claim a prompt: the running generation owns it.
    expect(mockSetPendingPrompt).not.toHaveBeenCalled();
    expect(mockRegisterActiveSession).not.toHaveBeenCalled();
    // A busy session is the one that can hold a pending approval, so it is
    // always checked.
    expect(mockInterruptPendingApprovals).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_ID, sessionId: SESSION_ID, content: "hello" }),
    );
  });

  it("steers the message into the turn when it interrupted a pending approval", async () => {
    mockInterruptPendingApprovals.mockResolvedValue("steered");
    mockPrisma.chatMessage.findUnique.mockResolvedValue(storedRow());

    const res = await postMessage("do this instead");
    const body = await res.json();

    // The message joins the running turn: part of the conversation (no
    // queuedAt), reported as delivered with the steered flag, and it claims
    // no prompt and registers no generation  the run is already active.
    expect(res.status).toBe(200);
    expect(body.queued).toBe(false);
    expect(body.steered).toBe(true);
    expect(mockPrisma.chatMessage.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ queuedAt: null }) }),
    );
    expect(mockSetPendingPrompt).not.toHaveBeenCalled();
    expect(mockRegisterActiveSession).not.toHaveBeenCalled();
  });

  it("keeps the message queued when the approval was denied but the steer fell back", async () => {
    // Agent lives in another process: the denials still stand, but the
    // message waits for the drain.
    mockInterruptPendingApprovals.mockResolvedValue("queued");
    mockPrisma.chatMessage.findUnique.mockResolvedValue(storedRow({ queuedAt: new Date() }));

    const res = await postMessage("do this instead");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.queued).toBe(true);
    expect(body.steered).toBeUndefined();
    expect(mockPrisma.chatMessage.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ queuedAt: expect.any(Date) }) }),
    );
  });

  it("tells connected clients the queue changed", async () => {
    mockPrisma.chatMessage.findUnique.mockResolvedValue(storedRow({ queuedAt: new Date() }));
    mockPrisma.chatMessage.findMany.mockResolvedValue([storedRow({ queuedAt: new Date() })]);

    await postMessage("hello");

    expect(mockPublishSessionEvent).toHaveBeenCalledWith(
      SESSION_ID,
      "queue_update",
      expect.objectContaining({ messages: expect.any(Array) }),
    );
  });

  it("rejects with 429 when the send queue is full", async () => {
    mockPrisma.chatMessage.count.mockResolvedValue(MAX_QUEUED_MESSAGES);

    const res = await postMessage("hello");
    const body = await res.json();

    expect(res.status).toBe(429);
    expect(body.error).toContain(String(MAX_QUEUED_MESSAGES));
    expect(mockPrisma.chatMessage.create).not.toHaveBeenCalled();
  });
});

describe("POST /messages while a manual compaction holds the session", () => {
  beforeEach(() => {
    // No generation of ours: the compaction flag (`isSessionBusy`) is what
    // makes the session refuse a prompt. Pi would reject one submitted now.
    mockIsSessionActive.mockResolvedValue(false);
    mockIsSessionBusy.mockResolvedValue(true);
  });

  it("queues the message instead of prompting into the compaction", async () => {
    mockPrisma.chatMessage.findUnique.mockResolvedValue(storedRow({ queuedAt: new Date() }));

    const res = await postMessage("sent mid-compaction");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.queued).toBe(true);
    expect(mockPrisma.chatMessage.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ queuedAt: expect.any(Date) }),
      }),
    );

    // The compaction owns the prompt: this message waits for the drain.
    expect(mockSetPendingPrompt).not.toHaveBeenCalled();
    expect(mockRegisterActiveSession).not.toHaveBeenCalled();
  });
});

describe("POST /messages while idle", () => {
  beforeEach(() => {
    mockIsSessionActive.mockResolvedValue(false);
  });

  it("saves normally, claims the prompt, and reports queued: false", async () => {
    mockPrisma.chatMessage.findUnique.mockResolvedValue(storedRow());

    const res = await postMessage("hello");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.queued).toBe(false);
    expect(body.streamUrl).toBe(`/api/chat/sessions/${SESSION_ID}/stream`);
    expect(mockSetPendingPrompt).toHaveBeenCalledWith(SESSION_ID, "msg-1");
    expect(mockRegisterActiveSession).toHaveBeenCalledWith(USER_ID, SESSION_ID);
    expect(mockPrisma.chatMessage.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ queuedAt: null }) }),
    );
  });

  it("resumes a stopped queue by accepting the message", async () => {
    // Stop holds the queue; sending something is the user asking to go on.
    mockPrisma.chatMessage.findUnique.mockResolvedValue(storedRow());

    await postMessage("keep going");

    expect(mockReleaseSendQueue).toHaveBeenCalledWith(SESSION_ID);
  });

  it("does not check the queue cap when nothing is running", async () => {
    mockPrisma.chatMessage.findUnique.mockResolvedValue(storedRow());

    await postMessage("hello");

    expect(mockPrisma.chatMessage.count).not.toHaveBeenCalled();
    expect(mockInterruptPendingApprovals).not.toHaveBeenCalled();
  });
});
