import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * Queue actions are the user's control over a message that has not reached the
 * agent yet. The important distinctions:
 *  - editing/cancelling must only touch messages still in the queue (a
 *    delivered message is part of the conversation),
 *  - "send now" prefers steering into the running agent, and if it cannot, the
 *    message must stay queued rather than vanish.
 */

const {
  mockRequireChatSessionOwner,
  mockIsSessionActive,
  mockRegisterActiveSession,
  mockSetPendingPrompt,
  mockGetPoolEntry,
  mockSteer,
  mockReadImageAsBase64,
} = vi.hoisted(() => ({
  mockRequireChatSessionOwner: vi.fn(),
  mockIsSessionActive: vi.fn(),
  mockRegisterActiveSession: vi.fn().mockResolvedValue(undefined),
  mockSetPendingPrompt: vi.fn().mockResolvedValue(undefined),
  mockGetPoolEntry: vi.fn(),
  mockSteer: vi.fn().mockResolvedValue(undefined),
  mockReadImageAsBase64: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ requireChatSessionOwner: mockRequireChatSessionOwner }));
vi.mock("@/lib/redis", () => ({
  isSessionActive: mockIsSessionActive,
  registerActiveSession: mockRegisterActiveSession,
  setPendingPrompt: mockSetPendingPrompt,
}));
vi.mock("@/lib/pi/agent-pool", () => ({
  get: mockGetPoolEntry,
  getPoolKey: (userId: string, sessionId: string) => `${userId}:${sessionId}`,
}));
vi.mock("@/lib/image-attachment", () => ({ readImageAsBase64: mockReadImageAsBase64 }));
vi.mock("@/lib/pi/session-events", () => ({ publishSessionEvent: vi.fn().mockResolvedValue(1) }));

const {
  mockGetQueuedMessage,
  mockUpdateQueuedMessageContent,
  mockRemoveQueuedMessage,
  mockClaimQueuedMessage,
} = vi.hoisted(() => ({
  mockGetQueuedMessage: vi.fn(),
  mockUpdateQueuedMessageContent: vi.fn(),
  mockRemoveQueuedMessage: vi.fn(),
  mockClaimQueuedMessage: vi.fn(),
}));

vi.mock("@/lib/chat/queue", () => ({
  getQueuedMessage: mockGetQueuedMessage,
  updateQueuedMessageContent: mockUpdateQueuedMessageContent,
  removeQueuedMessage: mockRemoveQueuedMessage,
  claimQueuedMessage: mockClaimQueuedMessage,
  publishQueueUpdate: vi.fn().mockResolvedValue(undefined),
}));

import { DELETE, PATCH, POST } from "@/app/api/chat/sessions/[sessionId]/queue/[messageId]/route";

const SESSION_ID = "session-1";
const USER_ID = "user-1";
const MESSAGE_ID = "msg-1";
const URL = `http://localhost/api/chat/sessions/${SESSION_ID}/queue/${MESSAGE_ID}`;
const params = { params: Promise.resolve({ sessionId: SESSION_ID, messageId: MESSAGE_ID }) };

function queuedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: MESSAGE_ID,
    sessionId: SESSION_ID,
    role: "user",
    content: "queued text",
    thinking: null,
    toolCalls: null,
    errorMessage: null,
    parentMessageId: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    editedAt: null,
    queuedAt: new Date("2026-01-01T00:01:00Z"),
    attachments: [],
    ...overrides,
  };
}

describe("PATCH /queue/:messageId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireChatSessionOwner.mockResolvedValue({ ok: true, userId: USER_ID, session: {} });
  });

  it("rewrites the queued text", async () => {
    mockUpdateQueuedMessageContent.mockResolvedValue(queuedRow({ content: "edited text" }));

    const res = await PATCH(
      new NextRequest(URL, { method: "PATCH", body: JSON.stringify({ content: "edited text" }) }),
      params,
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.message.content).toBe("edited text");
    expect(mockUpdateQueuedMessageContent).toHaveBeenCalledWith(
      SESSION_ID,
      MESSAGE_ID,
      "edited text",
    );
  });

  it("rejects empty content", async () => {
    const res = await PATCH(
      new NextRequest(URL, { method: "PATCH", body: JSON.stringify({ content: "   " }) }),
      params,
    );

    expect(res.status).toBe(400);
    expect(mockUpdateQueuedMessageContent).not.toHaveBeenCalled();
  });

  it("reports a conflict when the message was already delivered", async () => {
    mockUpdateQueuedMessageContent.mockResolvedValue(null);

    const res = await PATCH(
      new NextRequest(URL, { method: "PATCH", body: JSON.stringify({ content: "too late" }) }),
      params,
    );

    expect(res.status).toBe(409);
  });
});

describe("DELETE /queue/:messageId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireChatSessionOwner.mockResolvedValue({ ok: true, userId: USER_ID, session: {} });
  });

  it("cancels the queued message", async () => {
    mockRemoveQueuedMessage.mockResolvedValue(true);

    const res = await DELETE(new NextRequest(URL, { method: "DELETE" }), params);

    expect(res.status).toBe(200);
    expect(mockRemoveQueuedMessage).toHaveBeenCalledWith(USER_ID, SESSION_ID, MESSAGE_ID);
  });

  it("reports a conflict when the message is no longer queued", async () => {
    mockRemoveQueuedMessage.mockResolvedValue(false);

    const res = await DELETE(new NextRequest(URL, { method: "DELETE" }), params);

    expect(res.status).toBe(409);
  });
});

describe("POST /queue/:messageId (send now)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireChatSessionOwner.mockResolvedValue({ ok: true, userId: USER_ID, session: {} });
    mockGetQueuedMessage.mockResolvedValue(queuedRow());
    mockClaimQueuedMessage.mockResolvedValue(true);
  });

  it("hands an idle session's message to the prompt path", async () => {
    mockIsSessionActive.mockResolvedValue(false);

    const res = await POST(new NextRequest(URL, { method: "POST" }), params);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ delivered: true, mode: "prompt" });
    expect(mockClaimQueuedMessage).toHaveBeenCalledWith(SESSION_ID, MESSAGE_ID);
    expect(mockRegisterActiveSession).toHaveBeenCalledWith(USER_ID, SESSION_ID);
    expect(mockSetPendingPrompt).toHaveBeenCalledWith(SESSION_ID, MESSAGE_ID);
  });

  it("steers the message into the running agent", async () => {
    mockIsSessionActive.mockResolvedValue(true);
    mockGetPoolEntry.mockReturnValue({ session: { isStreaming: true, steer: mockSteer } });

    const res = await POST(new NextRequest(URL, { method: "POST" }), params);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ delivered: true, mode: "steered" });
    expect(mockSteer).toHaveBeenCalledWith("queued text");
    // Delivered => out of the queue, so clients move it into the conversation.
    expect(mockClaimQueuedMessage).toHaveBeenCalledWith(SESSION_ID, MESSAGE_ID);
  });

  it("passes image attachments to the running agent", async () => {
    mockIsSessionActive.mockResolvedValue(true);
    mockGetQueuedMessage.mockResolvedValue(
      queuedRow({ attachments: [{ storagePath: "images/a.png", mimeType: "image/png" }] }),
    );
    mockReadImageAsBase64.mockResolvedValue({ data: "base64", mimeType: "image/png" });
    mockGetPoolEntry.mockReturnValue({ session: { isStreaming: true, steer: mockSteer } });

    await POST(new NextRequest(URL, { method: "POST" }), params);

    expect(mockSteer).toHaveBeenCalledWith("queued text", [
      { type: "image", data: "base64", mimeType: "image/png" },
    ]);
  });

  it("keeps the message queued when Pi is streaming in another process", async () => {
    mockIsSessionActive.mockResolvedValue(true);
    mockGetPoolEntry.mockReturnValue(undefined);

    const res = await POST(new NextRequest(URL, { method: "POST" }), params);
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.delivered).toBe(false);
    expect(mockClaimQueuedMessage).not.toHaveBeenCalled();
  });

  it("keeps the message queued when steering fails", async () => {
    mockIsSessionActive.mockResolvedValue(true);
    mockSteer.mockRejectedValueOnce(new Error("agent gone"));
    mockGetPoolEntry.mockReturnValue({ session: { isStreaming: true, steer: mockSteer } });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await POST(new NextRequest(URL, { method: "POST" }), params);

    expect(res.status).toBe(500);
    expect(mockClaimQueuedMessage).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(MESSAGE_ID), expect.any(Error));
  });

  it("reports a conflict when the message left the queue", async () => {
    mockGetQueuedMessage.mockResolvedValue(null);

    const res = await POST(new NextRequest(URL, { method: "POST" }), params);

    expect(res.status).toBe(409);
    expect(mockIsSessionActive).not.toHaveBeenCalled();
  });
});
