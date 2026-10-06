import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Deleting a chat has to remove everything the chat owns, and it must never
 * touch a chat that belongs to someone else. The route and the `chat_delete`
 * tool share this path, so a bug here is reachable from an agent call.
 */

const mockFindFirst = vi.fn();
const mockFindMany = vi.fn();
const mockDeleteMany = vi.fn();
vi.mock("@/lib/db", () => ({
  prisma: {
    chatSession: {
      findFirst: (...args: unknown[]) => mockFindFirst(...args),
      deleteMany: (...args: unknown[]) => mockDeleteMany(...args),
    },
    chatMessage: { findMany: (...args: unknown[]) => mockFindMany(...args) },
  },
}));

const mockDeleteAllImages = vi.fn();
vi.mock("@/lib/image-attachment", () => ({
  deleteAllImages: (...args: unknown[]) => mockDeleteAllImages(...args),
}));

const mockRemove = vi.fn();
vi.mock("@/lib/pi/agent-pool", () => ({
  getPoolKey: (userId: string, sessionId: string) => `${userId}:${sessionId}`,
  getSessionDir: (userId: string, sessionId: string) =>
    `/tmp/saale-test-uploads/pi_sessions/${userId}/${sessionId}`,
  remove: (...args: unknown[]) => mockRemove(...args),
}));

const mockRm = vi.fn();
vi.mock("fs/promises", () => ({ default: { rm: (...args: unknown[]) => mockRm(...args) } }));

import { deleteChatSession } from "@/lib/chat/delete-session";

const USER_ID = "user-1";
const SESSION_ID = "chat-1";

describe("deleteChatSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindFirst.mockResolvedValue({ title: "Trip planning" });
    mockFindMany.mockResolvedValue([]);
    mockDeleteMany.mockResolvedValue({ count: 1 });
    mockDeleteAllImages.mockResolvedValue(undefined);
    mockRemove.mockResolvedValue(undefined);
    mockRm.mockResolvedValue(undefined);
  });

  it("deletes a chat the user owns and returns its title", async () => {
    const result = await deleteChatSession(USER_ID, SESSION_ID);

    expect(result).toEqual({ title: "Trip planning" });
    // Ownership is part of the lookup, not a separate check that could be skipped.
    expect(mockFindFirst).toHaveBeenCalledWith({
      where: { id: SESSION_ID, userId: USER_ID },
      select: { title: true },
    });
    expect(mockDeleteMany).toHaveBeenCalledWith({
      where: { id: SESSION_ID, userId: USER_ID },
    });
    expect(mockRemove).toHaveBeenCalledWith(`${USER_ID}:${SESSION_ID}`);
    expect(mockRm).toHaveBeenCalledWith(
      `/tmp/saale-test-uploads/pi_sessions/${USER_ID}/${SESSION_ID}`,
      { recursive: true, force: true },
    );
  });

  it("refuses a chat the user does not own, before touching anything", async () => {
    mockFindFirst.mockResolvedValue(null);

    await expect(deleteChatSession(USER_ID, "someone-elses-chat")).rejects.toThrow(
      "Chat not found: someone-elses-chat",
    );
    expect(mockDeleteMany).not.toHaveBeenCalled();
    expect(mockDeleteAllImages).not.toHaveBeenCalled();
    expect(mockRemove).not.toHaveBeenCalled();
  });

  it("deletes attachment files before the DB rows", async () => {
    mockFindMany.mockResolvedValue([
      { attachments: [{ storagePath: "user-1/a.png" }, { storagePath: "user-1/b.pdf" }] },
      { attachments: [] },
    ]);

    await deleteChatSession(USER_ID, SESSION_ID);

    expect(mockDeleteAllImages).toHaveBeenCalledWith(USER_ID, ["user-1/a.png", "user-1/b.pdf"]);
    // Files first, so a failure leaves the session deletable again.
    expect(mockDeleteAllImages.mock.invocationCallOrder[0]!).toBeLessThan(
      mockDeleteMany.mock.invocationCallOrder[0]!,
    );
  });

  it("skips image cleanup when the chat has no attachments", async () => {
    mockFindMany.mockResolvedValue([{ attachments: [] }]);

    await deleteChatSession(USER_ID, SESSION_ID);

    expect(mockDeleteAllImages).not.toHaveBeenCalled();
  });

  it("leaves the DB intact when an attachment cannot be deleted", async () => {
    mockFindMany.mockResolvedValue([{ attachments: [{ storagePath: "user-1/a.png" }] }]);
    mockDeleteAllImages.mockRejectedValue(new Error("disk on fire"));

    await expect(deleteChatSession(USER_ID, SESSION_ID)).rejects.toThrow("disk on fire");
    expect(mockDeleteMany).not.toHaveBeenCalled();
  });
});
