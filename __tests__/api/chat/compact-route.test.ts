import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * The route is a thin HTTP wrapper: authentication, then the shared
 * `compactChatSession` helper, then a status per failure reason. The
 * compaction behaviour itself is covered by `__tests__/lib/chat/compact-chat`.
 */

const { mockRequireChatSessionOwner, mockCompactChatSession } = vi.hoisted(() => ({
  mockRequireChatSessionOwner: vi.fn(),
  mockCompactChatSession: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ requireChatSessionOwner: mockRequireChatSessionOwner }));
vi.mock("@/lib/chat/compact-chat", () => ({ compactChatSession: mockCompactChatSession }));

import { POST } from "@/app/api/chat/sessions/[sessionId]/compact/route";

const USER_ID = "compact-user";
const SESSION_ID = "compact-session";

function compactRequest() {
  return POST(new NextRequest("http://localhost/api/chat/sessions/x/compact", { method: "POST" }), {
    params: Promise.resolve({ sessionId: SESSION_ID }),
  });
}

describe("POST /api/chat/sessions/[sessionId]/compact", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireChatSessionOwner.mockResolvedValue({ ok: true, userId: USER_ID });
  });

  it("returns the token count on success", async () => {
    mockCompactChatSession.mockResolvedValue({ ok: true, tokensBefore: 1000 });

    const res = await compactRequest();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ compacted: true, tokensBefore: 1000 });
    expect(mockCompactChatSession).toHaveBeenCalledWith({ userId: USER_ID, sessionId: SESSION_ID });
  });

  it("rejects a chat with no resolvable model with 400", async () => {
    mockCompactChatSession.mockResolvedValue({
      ok: false,
      code: "no-model",
      message: "No AI model configured",
    });

    const res = await compactRequest();

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("No AI model configured");
  });

  it("maps Pi's already-compacted error to 409 with the client's error code", async () => {
    mockCompactChatSession.mockResolvedValue({
      ok: false,
      code: "already-compacted",
      message: "This conversation is already compacted",
    });

    const res = await compactRequest();

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: "already_compacted",
      message: "This conversation is already compacted",
    });
  });

  it("maps a too-small conversation to 409 with the client's error code", async () => {
    mockCompactChatSession.mockResolvedValue({
      ok: false,
      code: "nothing-to-compact",
      message: "The conversation is too short to compact",
    });

    const res = await compactRequest();

    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("nothing_to_compact");
  });

  it("reports an unexpected failure as 500", async () => {
    mockCompactChatSession.mockResolvedValue({
      ok: false,
      code: "failed",
      message: "Compaction failed",
    });

    const res = await compactRequest();

    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("Compaction failed");
  });

  it("never compacts a session the caller does not own", async () => {
    mockRequireChatSessionOwner.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: "Not found" }), { status: 404 }),
    });

    const res = await compactRequest();

    expect(res.status).toBe(404);
    expect(mockCompactChatSession).not.toHaveBeenCalled();
  });
});
