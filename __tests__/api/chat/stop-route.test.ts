import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * The stop route is the only place that records a user-initiated abort. Without
 * the record, the session event tracker cannot tell the cancelled request from a
 * provider failure (Pi reports both with stopReason "error") and would show an
 * error notice for the user's own Stop.
 */

const { mockRequireChatSessionOwner, mockIsSessionActive, mockUnregister, mockGet, mockAbort } =
  vi.hoisted(() => ({
    mockRequireChatSessionOwner: vi.fn(),
    mockIsSessionActive: vi.fn(),
    mockUnregister: vi.fn(),
    mockGet: vi.fn(),
    mockAbort: vi.fn(),
  }));

vi.mock("@/lib/auth", () => ({ requireChatSessionOwner: mockRequireChatSessionOwner }));

vi.mock("@/lib/redis", () => ({
  isSessionActive: mockIsSessionActive,
  unregisterActiveSession: mockUnregister,
}));

vi.mock("@/lib/pi/agent-pool", () => ({
  get: mockGet,
  getPoolKey: (userId: string, sessionId: string) => `${userId}:${sessionId}`,
}));

import { POST } from "@/app/api/chat/sessions/[sessionId]/stop/route";
import { clearSessionAbort, wasSessionAbortRequested } from "@/lib/pi/abort-request";

const USER_ID = "stop-route-user";
const SESSION_ID = "stop-route-session";

function stopRequest() {
  return POST(new NextRequest("http://localhost/api/chat/sessions/x/stop", { method: "POST" }), {
    params: Promise.resolve({ sessionId: SESSION_ID }),
  });
}

describe("POST /api/chat/sessions/[sessionId]/stop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The record is module state, shared across a test file.
    clearSessionAbort(USER_ID, SESSION_ID);
    mockRequireChatSessionOwner.mockResolvedValue({ ok: true, userId: USER_ID, session: {} });
    mockIsSessionActive.mockResolvedValue(true);
    mockUnregister.mockResolvedValue(undefined);
    mockGet.mockReturnValue({ session: { abort: mockAbort, isStreaming: true } });
  });

  it("records the abort before cancelling the generation", async () => {
    const res = await stopRequest();

    expect(mockAbort).toHaveBeenCalled();
    expect(wasSessionAbortRequested(USER_ID, SESSION_ID)).toBe(true);
    await expect(res.json()).resolves.toEqual({ stopped: true });
    expect(mockUnregister).toHaveBeenCalledWith(USER_ID, SESSION_ID);
  });

  it("still cancels a streaming session when the Redis flag is missing", async () => {
    // A lost flag (expired key, Redis restart) must not turn Stop into a no-op:
    // the pooled session is the truth for this process.
    mockIsSessionActive.mockResolvedValue(false);

    await stopRequest();

    expect(mockAbort).toHaveBeenCalled();
    expect(wasSessionAbortRequested(USER_ID, SESSION_ID)).toBe(true);
  });

  it("clears the flag without aborting when the session runs elsewhere", async () => {
    // No pool entry here: another instance owns the generation. This process
    // cancels nothing, so it must not record a stop either.
    mockGet.mockReturnValue(undefined);

    await stopRequest();

    expect(mockAbort).not.toHaveBeenCalled();
    expect(wasSessionAbortRequested(USER_ID, SESSION_ID)).toBe(false);
    expect(mockUnregister).toHaveBeenCalledWith(USER_ID, SESSION_ID);
  });

  it("does nothing when no generation is running", async () => {
    mockIsSessionActive.mockResolvedValue(false);
    mockGet.mockReturnValue({ session: { abort: mockAbort, isStreaming: false } });

    await stopRequest();

    expect(mockAbort).not.toHaveBeenCalled();
    expect(wasSessionAbortRequested(USER_ID, SESSION_ID)).toBe(false);
    expect(mockUnregister).not.toHaveBeenCalled();
  });
});
