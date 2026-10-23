import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

/**
 * The bulk endpoint is what the sidebar's "delete selected chats" hits. It has
 * to keep the batch bounded, reject junk ids before the loop, and  above all
 * pass the signed-in user through, since that is the only thing scoping every
 * id in the batch to its owner.
 */

const { mockRequireSession, mockDeleteChatSessions } = vi.hoisted(() => ({
  mockRequireSession: vi.fn(),
  mockDeleteChatSessions: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ requireSession: mockRequireSession }));
vi.mock("@/lib/chat/delete-session", () => ({ deleteChatSessions: mockDeleteChatSessions }));

import { POST } from "@/app/api/chat/sessions/bulk/route";

const USER_ID = "bulk-route-user";

function bulkRequest(body: unknown) {
  return POST(
    new NextRequest("http://localhost/api/chat/sessions/bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

describe("POST /api/chat/sessions/bulk", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireSession.mockResolvedValue({ ok: true, user: { id: USER_ID } });
    mockDeleteChatSessions.mockResolvedValue({ deleted: [], failed: [] });
  });

  it("deletes the batch for the signed-in user", async () => {
    mockDeleteChatSessions.mockResolvedValue({ deleted: ["chat-1", "chat-2"], failed: [] });

    const res = await bulkRequest({ ids: ["chat-1", "chat-2"] });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: ["chat-1", "chat-2"], failed: [] });
    expect(mockDeleteChatSessions).toHaveBeenCalledWith(USER_ID, ["chat-1", "chat-2"], false);
  });

  it("reports the chats that survived instead of failing the whole batch", async () => {
    mockDeleteChatSessions.mockResolvedValue({
      deleted: ["chat-1"],
      failed: [{ sessionId: "chat-2", error: "Chat not found: chat-2" }],
    });

    const res = await bulkRequest({ ids: ["chat-1", "chat-2"] });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      deleted: ["chat-1"],
      failed: [{ sessionId: "chat-2", error: "Chat not found: chat-2" }],
    });
  });

  it("refuses when there is no session", async () => {
    mockRequireSession.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    });

    const res = await bulkRequest({ ids: ["chat-1"] });

    expect(res.status).toBe(401);
    expect(mockDeleteChatSessions).not.toHaveBeenCalled();
  });

  it.each([
    ["an empty list", { ids: [] }],
    ["a missing list", {}],
    ["a non-array", { ids: "chat-1" }],
    ["an empty id", { ids: [""] }],
  ])("rejects %s before touching the database", async (_label, body) => {
    const res = await bulkRequest(body);

    expect(res.status).toBe(400);
    expect(mockDeleteChatSessions).not.toHaveBeenCalled();
  });

  it("rejects a batch beyond the cap", async () => {
    const res = await bulkRequest({
      ids: Array.from({ length: 101 }, (_, index) => `chat-${index}`),
    });

    expect(res.status).toBe(400);
    expect(mockDeleteChatSessions).not.toHaveBeenCalled();
  });

  it("answers 400 for a body that is not JSON", async () => {
    const res = await bulkRequest("not json");

    expect(res.status).toBe(400);
    expect(mockDeleteChatSessions).not.toHaveBeenCalled();
  });
});
