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

const mockIsSessionActive = vi.fn();
vi.mock("@/lib/redis", () => ({
  isSessionActive: (...args: unknown[]) => mockIsSessionActive(...args),
}));

const mockGetProvisioning = vi.fn();
vi.mock("@/lib/coder/provisioning", () => ({
  getProvisioning: (...args: unknown[]) => mockGetProvisioning(...args),
}));

const mockRemoveChatWorktree = vi.fn();
vi.mock("@/lib/coder/worktree-removal", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/coder/worktree-removal")>();
  return { ...actual, removeChatWorktree: (...args: unknown[]) => mockRemoveChatWorktree(...args) };
});

const mockLoadChatCheckout = vi.fn();
vi.mock("@/lib/coder/checkout", () => ({
  loadChatCheckout: (...args: unknown[]) => mockLoadChatCheckout(...args),
}));

const mockStopChatProcesses = vi.fn();
vi.mock("@/lib/coder/processes", () => ({
  stopChatProcesses: (...args: unknown[]) => mockStopChatProcesses(...args),
}));

import { autoDeleteChatSession, deleteChatSession } from "@/lib/chat/delete-session";

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
    mockLoadChatCheckout.mockResolvedValue(null);
    mockStopChatProcesses.mockResolvedValue(undefined);
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

  it("stops what a chat left running in the project's shared checkout", async () => {
    mockFindFirst.mockResolvedValue({ title: "Coder chat", projectId: "project-1" });
    mockLoadChatCheckout.mockResolvedValue({ path: "projects/saale", mode: "repo" });

    await deleteChatSession(USER_ID, SESSION_ID);

    expect(mockStopChatProcesses).toHaveBeenCalledWith(USER_ID, SESSION_ID);
  });

  it("leaves the processes alone when removing the worktree already stopped them", async () => {
    mockFindFirst.mockResolvedValue({ title: "Coder chat", projectId: "project-1" });
    mockRemoveChatWorktree.mockResolvedValue({ path: "worktrees/saale/c-1a2b3c4d", removed: true });

    await deleteChatSession(USER_ID, SESSION_ID);

    expect(mockLoadChatCheckout).not.toHaveBeenCalled();
    expect(mockStopChatProcesses).not.toHaveBeenCalled();
  });

  it("does not sweep anything for a chat that is not a coder chat", async () => {
    await deleteChatSession(USER_ID, SESSION_ID);

    expect(mockRemoveChatWorktree).not.toHaveBeenCalled();
    expect(mockStopChatProcesses).not.toHaveBeenCalled();
  });
});

describe("autoDeleteChatSession", () => {
  // The leave-the-page path. Its input is a browser guess that the chat is
  // empty, so every case here is about what the server knows better.
  const idleSession = { temporary: false, _count: { messages: 0 } };

  beforeEach(() => {
    vi.clearAllMocks();
    mockFindFirst.mockResolvedValue(idleSession);
    mockFindMany.mockResolvedValue([]);
    mockDeleteMany.mockResolvedValue({ count: 1 });
    mockDeleteAllImages.mockResolvedValue(undefined);
    mockWatcherFindMany.mockResolvedValue([]);
    mockRemove.mockResolvedValue(undefined);
    mockRm.mockResolvedValue(undefined);
    mockRemoveChatWorktree.mockResolvedValue({ path: null, removed: false });
    mockIsSessionActive.mockResolvedValue(false);
    mockGetProvisioning.mockResolvedValue(null);
  });

  it("deletes a chat the user abandoned before sending anything", async () => {
    const result = await autoDeleteChatSession(USER_ID, SESSION_ID);

    expect(result).toEqual({ deleted: true });
    expect(mockDeleteMany).toHaveBeenCalledWith({ where: { id: SESSION_ID, userId: USER_ID } });
  });

  it("keeps a chat whose workspace is still being built", async () => {
    mockFindFirst.mockResolvedValue({ temporary: false, _count: { messages: 1 } });
    mockGetProvisioning.mockResolvedValue({ step: "setup", startedAt: new Date().toISOString() });

    const result = await autoDeleteChatSession(USER_ID, SESSION_ID);

    expect(result).toEqual({ deleted: false, kept: "provisioning" });
    expect(mockDeleteMany).not.toHaveBeenCalled();
    // The worktree is untouched: the install running in it is still wanted.
    expect(mockRemoveChatWorktree).not.toHaveBeenCalled();
  });

  it("keeps a chat a generation is running in", async () => {
    mockIsSessionActive.mockResolvedValue(true);

    const result = await autoDeleteChatSession(USER_ID, SESSION_ID);

    expect(result).toEqual({ deleted: false, kept: "running" });
    expect(mockDeleteMany).not.toHaveBeenCalled();
  });

  it("keeps a chat that has messages, whatever the client thought", async () => {
    mockFindFirst.mockResolvedValue({ temporary: false, _count: { messages: 2 } });

    const result = await autoDeleteChatSession(USER_ID, SESSION_ID);

    expect(result).toEqual({ deleted: false, kept: "started" });
    expect(mockDeleteMany).not.toHaveBeenCalled();
  });

  it("still deletes a temporary chat, messages and all", async () => {
    mockFindFirst.mockResolvedValue({ temporary: true, _count: { messages: 5 } });

    const result = await autoDeleteChatSession(USER_ID, SESSION_ID);

    expect(result).toEqual({ deleted: true });
    expect(mockDeleteMany).toHaveBeenCalled();
  });

  it("is a no-op for a chat that is already gone or not the user's", async () => {
    mockFindFirst.mockResolvedValue(null);

    const result = await autoDeleteChatSession(USER_ID, "someone-elses-chat");

    expect(result).toEqual({ deleted: false, kept: "missing" });
    expect(mockDeleteMany).not.toHaveBeenCalled();
  });

  it("looks the chat up with the owner in the query", async () => {
    await autoDeleteChatSession(USER_ID, SESSION_ID);

    expect(mockFindFirst).toHaveBeenCalledWith({
      where: { id: SESSION_ID, userId: USER_ID },
      select: { temporary: true, _count: { select: { messages: true } } },
    });
  });
});
