import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

/**
 * The delete endpoint is what every chat list hits, for one row and for a
 * selection. It has to keep the batch bounded, reject junk ids before the loop,
 * and above all pass the signed-in user through, since that is the only thing
 * scoping every id in the batch to its owner.
 */

const { mockRequireSession, mockQueueChatDeletes } = vi.hoisted(() => ({
  mockRequireSession: vi.fn(),
  mockQueueChatDeletes: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ requireSession: mockRequireSession }));
vi.mock("@/lib/chat/delete-runner", () => ({ queueChatDeletes: mockQueueChatDeletes }));

import { POST } from "@/app/api/chat/sessions/delete/route";

const USER_ID = "delete-route-user";

function deleteRequest(body: unknown) {
  return POST(
    new NextRequest("http://localhost/api/chat/sessions/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

describe("POST /api/chat/sessions/delete", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireSession.mockResolvedValue({ ok: true, user: { id: USER_ID } });
    mockQueueChatDeletes.mockResolvedValue({ queued: [], failed: [] });
  });

  it("deletes one chat as a list of one", async () => {
    mockQueueChatDeletes.mockResolvedValue({ queued: ["chat-1"], failed: [] });

    const res = await deleteRequest({ ids: ["chat-1"] });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ queued: ["chat-1"], failed: [] });
    expect(mockQueueChatDeletes).toHaveBeenCalledWith(USER_ID, ["chat-1"], false);
  });

  it("deletes the batch for the signed-in user", async () => {
    mockQueueChatDeletes.mockResolvedValue({ queued: ["chat-1", "chat-2"], failed: [] });

    const res = await deleteRequest({ ids: ["chat-1", "chat-2"] });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ queued: ["chat-1", "chat-2"], failed: [] });
    expect(mockQueueChatDeletes).toHaveBeenCalledWith(USER_ID, ["chat-1", "chat-2"], false);
  });

  it("passes force through to the deletion so a dirty checkout can go", async () => {
    await deleteRequest({ ids: ["chat-1"], force: true });

    expect(mockQueueChatDeletes).toHaveBeenCalledWith(USER_ID, ["chat-1"], true);
  });

  it("treats a missing force as a plain delete", async () => {
    await deleteRequest({ ids: ["chat-1"], force: "yes" });

    expect(mockQueueChatDeletes).not.toHaveBeenCalled();
  });

  it("reports the chats that survived instead of failing the whole batch", async () => {
    mockQueueChatDeletes.mockResolvedValue({
      queued: ["chat-1"],
      failed: [{ sessionId: "chat-2", error: "Chat not found: chat-2", code: "worktree-kept" }],
    });

    const res = await deleteRequest({ ids: ["chat-1", "chat-2"] });

    expect(res.status).toBe(200);
    // The refusal's code travels with the error: the sidebar needs it to offer a
    // confirmed retry instead of a plain failure.
    expect(await res.json()).toEqual({
      queued: ["chat-1"],
      failed: [{ sessionId: "chat-2", error: "Chat not found: chat-2", code: "worktree-kept" }],
    });
  });

  it("refuses when there is no session", async () => {
    mockRequireSession.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    });

    const res = await deleteRequest({ ids: ["chat-1"] });

    expect(res.status).toBe(401);
    expect(mockQueueChatDeletes).not.toHaveBeenCalled();
  });

  it.each([
    ["an empty list", { ids: [] }],
    ["a missing list", {}],
    ["a non-array", { ids: "chat-1" }],
    ["an empty id", { ids: [""] }],
  ])("rejects %s before touching the database", async (_label, body) => {
    const res = await deleteRequest(body);

    expect(res.status).toBe(400);
    expect(mockQueueChatDeletes).not.toHaveBeenCalled();
  });

  it("rejects a batch beyond the cap", async () => {
    const res = await deleteRequest({
      ids: Array.from({ length: 101 }, (_, index) => `chat-${index}`),
    });

    expect(res.status).toBe(400);
    expect(mockQueueChatDeletes).not.toHaveBeenCalled();
  });

  it("answers 400 for a body that is not JSON", async () => {
    const res = await deleteRequest("not json");

    expect(res.status).toBe(400);
    expect(mockQueueChatDeletes).not.toHaveBeenCalled();
  });
});
