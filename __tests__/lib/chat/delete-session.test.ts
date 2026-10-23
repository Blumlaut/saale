import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Deleting a chat has to remove everything the chat owns, and it must never
 * touch a chat that belongs to someone else. The route and the `chat_delete`
 * tool share this path, so a bug here is reachable from an agent call.
 */

const mockFindFirst = vi.fn();
const mockFindMany = vi.fn();
const mockDeleteMany = vi.fn();
const mockWatcherFindMany = vi.fn();
vi.mock("@/lib/db", () => ({
  prisma: {
    chatSession: {
      findFirst: (...args: unknown[]) => mockFindFirst(...args),
      deleteMany: (...args: unknown[]) => mockDeleteMany(...args),
    },
    chatMessage: { findMany: (...args: unknown[]) => mockFindMany(...args) },
    // The cascade removes the rows; the mock has to hand back the ids so the
    // scheduler-cleanup under test can see them.
    scriptWatcher: { findMany: (...args: unknown[]) => mockWatcherFindMany(...args) },
  },
}));

const mockUnscheduleWatcher = vi.fn();
vi.mock("@/lib/queue", () => ({
  unscheduleWatcher: (...args: unknown[]) => mockUnscheduleWatcher(...args),
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

const mockRemoveChatWorktree = vi.fn();
vi.mock("@/lib/coder/worktree-removal", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/coder/worktree-removal")>();
  return { ...actual, removeChatWorktree: (...args: unknown[]) => mockRemoveChatWorktree(...args) };
});

import { deleteChatSession, deleteChatSessions } from "@/lib/chat/delete-session";
import { CoderCleanupError } from "@/lib/coder/worktree-removal";
import { DIRTY_WORKTREE_CODE } from "@/lib/coder/cleanup-codes";

const USER_ID = "user-1";
const SESSION_ID = "chat-1";

describe("deleteChatSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindFirst.mockResolvedValue({ title: "Trip planning" });
    mockFindMany.mockResolvedValue([]);
    mockDeleteMany.mockResolvedValue({ count: 1 });
    mockDeleteAllImages.mockResolvedValue(undefined);
    mockWatcherFindMany.mockResolvedValue([]);
    mockRemove.mockResolvedValue(undefined);
    mockRm.mockResolvedValue(undefined);
    mockRemoveChatWorktree.mockResolvedValue({ path: null, removed: false });
  });

  it("deletes a chat the user owns and returns its title", async () => {
    const result = await deleteChatSession(USER_ID, SESSION_ID);

    expect(result).toEqual({ title: "Trip planning" });
    // Ownership is part of the lookup, not a separate check that could be skipped.
    expect(mockFindFirst).toHaveBeenCalledWith({
      where: { id: SESSION_ID, userId: USER_ID },
      select: { title: true, projectId: true },
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

  it("unschedules every watcher the chat created", async () => {
    mockWatcherFindMany.mockResolvedValue([{ id: "w-1" }, { id: "w-2" }]);

    await deleteChatSession(USER_ID, SESSION_ID);

    // The lookup is scoped to the chat's owner, not just the session id.
    expect(mockWatcherFindMany).toHaveBeenCalledWith({
      where: { sessionId: SESSION_ID, userId: USER_ID },
      select: { id: true },
    });
    expect(mockUnscheduleWatcher).toHaveBeenCalledTimes(2);
    expect(mockUnscheduleWatcher).toHaveBeenCalledWith("w-1");
    expect(mockUnscheduleWatcher).toHaveBeenCalledWith("w-2");
  });

  it("does nothing to the queue when the chat has no watchers", async () => {
    await deleteChatSession(USER_ID, SESSION_ID);

    expect(mockUnscheduleWatcher).not.toHaveBeenCalled();
  });

  it("forwards force to the checkout removal", async () => {
    mockFindFirst.mockResolvedValue({ title: "Coder chat", projectId: "project-1" });

    await deleteChatSession(USER_ID, SESSION_ID, true);

    expect(mockRemoveChatWorktree).toHaveBeenCalledWith(USER_ID, SESSION_ID, true);
    expect(mockDeleteMany).toHaveBeenCalled();
  });
});

describe("deleteChatSessions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindFirst.mockImplementation(async ({ where }: { where: { id: string } }) => ({
      title: where.id,
    }));
    mockFindMany.mockResolvedValue([]);
    mockDeleteMany.mockResolvedValue({ count: 1 });
    mockDeleteAllImages.mockResolvedValue(undefined);
    mockWatcherFindMany.mockResolvedValue([]);
    mockRemove.mockResolvedValue(undefined);
    mockRm.mockResolvedValue(undefined);
    mockRemoveChatWorktree.mockResolvedValue({ path: null, removed: false });
  });

  it("deletes every chat in the batch, each scoped to its owner", async () => {
    const result = await deleteChatSessions(USER_ID, ["chat-1", "chat-2"]);

    expect(result).toEqual({ deleted: ["chat-1", "chat-2"], failed: [] });
    expect(mockDeleteMany).toHaveBeenCalledWith({ where: { id: "chat-2", userId: USER_ID } });
    expect(mockRemove).toHaveBeenCalledWith(`${USER_ID}:chat-2`);
  });

  it("keeps going when one chat is not the user's", async () => {
    mockFindFirst.mockImplementation(async ({ where }: { where: { id: string } }) =>
      where.id === "someone-elses-chat" ? null : { title: where.id },
    );

    const result = await deleteChatSessions(USER_ID, ["chat-1", "someone-elses-chat", "chat-2"]);

    expect(result.deleted).toEqual(["chat-1", "chat-2"]);
    expect(result.failed).toEqual([
      { sessionId: "someone-elses-chat", error: "Chat not found: someone-elses-chat" },
    ]);
    // The batch is not aborted: the chats around the failure still went.
    expect(mockDeleteMany).toHaveBeenCalledTimes(2);
  });

  it("counts a repeated id once", async () => {
    const result = await deleteChatSessions(USER_ID, ["chat-1", "chat-1"]);

    expect(result).toEqual({ deleted: ["chat-1"], failed: [] });
    expect(mockDeleteMany).toHaveBeenCalledTimes(1);
  });

  it("tells the caller which refusal a force delete would override", async () => {
    mockFindFirst.mockResolvedValue({ title: "Coder chat", projectId: "project-1" });
    mockRemoveChatWorktree.mockRejectedValue(
      new CoderCleanupError(
        "fatal: contains modified or untracked files, use --force to delete it",
        409,
        DIRTY_WORKTREE_CODE,
      ),
    );

    const result = await deleteChatSessions(USER_ID, ["chat-1"]);

    expect(result.deleted).toEqual([]);
    expect(result.failed).toEqual([
      {
        sessionId: "chat-1",
        error: "fatal: contains modified or untracked files, use --force to delete it",
        code: DIRTY_WORKTREE_CODE,
      },
    ]);
    // The chat and its checkout survive, ready for the confirmed retry.
    expect(mockDeleteMany).not.toHaveBeenCalled();
  });

  it("passes force on to every chat in the batch", async () => {
    mockFindFirst.mockImplementation(async ({ where }: { where: { id: string } }) => ({
      title: where.id,
      projectId: "project-1",
    }));

    await deleteChatSessions(USER_ID, ["chat-1", "chat-2"], true);

    expect(mockRemoveChatWorktree.mock.calls).toEqual([
      [USER_ID, "chat-1", true],
      [USER_ID, "chat-2", true],
    ]);
  });

  it("unschedules only the watchers of the chats that actually went", async () => {
    mockFindFirst.mockImplementation(async ({ where }: { where: { id: string } }) =>
      where.id === "someone-elses-chat" ? null : { title: where.id },
    );
    mockWatcherFindMany.mockImplementation(async ({ where }: { where: { sessionId: string } }) =>
      where.sessionId === "chat-1" ? [{ id: `watcher-${where.sessionId}` }] : [],
    );

    const result = await deleteChatSessions(USER_ID, ["chat-1", "someone-elses-chat", "chat-2"]);

    expect(result.deleted).toEqual(["chat-1", "chat-2"]);
    expect(mockUnscheduleWatcher).toHaveBeenCalledTimes(1);
    expect(mockUnscheduleWatcher).toHaveBeenCalledWith("watcher-chat-1");
  });
});
