import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The deletes a user does not wait for.
 *
 * A request marks the chats and answers; this module removes them. What has to
 * hold: the mark is what the lists read, a checkout holding work refuses before
 * anything is marked, and a removal that fails puts the row back instead of
 * leaving a chat greyed forever.
 */

const chats = new Map<string, { userId: string; projectId: string | null }>();
const marked = new Map<string, { userId: string; deletingForce: boolean }>();

vi.mock("@/lib/db", () => ({
  prisma: {
    chatSession: {
      findFirst: async ({ where }: { where: { id?: string; userId?: string } }) => {
        if (where.id === undefined) {
          const first = marked.entries().next();
          if (first.done) return null;
          const [id, row] = first.value;
          return { id, userId: row.userId, deletingForce: row.deletingForce };
        }
        const chat = chats.get(where.id);
        if (!chat || chat.userId !== where.userId) return null;
        return { projectId: chat.projectId };
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: { deletingAt: Date | null; deletingForce: boolean };
      }) => {
        if (data.deletingAt === null) {
          marked.delete(where.id);
          return { count: 1 };
        }
        const chat = chats.get(where.id);
        if (!chat) return { count: 0 };
        marked.set(where.id, { userId: chat.userId, deletingForce: data.deletingForce });
        return { count: 1 };
      },
    },
  },
}));

/** Whether the chat was still marked when its removal ran. */
const markedAtRemoval: boolean[] = [];

const mockDeleteChatSession = vi.fn(async (userId: string, sessionId: string, _force?: boolean) => {
  markedAtRemoval.push(marked.has(sessionId));
  chats.delete(sessionId);
  marked.delete(sessionId);
  return { title: sessionId };
});
vi.mock("@/lib/chat/delete-session", () => ({
  deleteChatSession: (userId: string, sessionId: string, force?: boolean) =>
    mockDeleteChatSession(userId, sessionId, force),
}));

const mockRefuse = vi.fn();
vi.mock("@/lib/coder/worktree-removal", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/coder/worktree-removal")>();
  return { ...actual, refuseChatWorktreeDelete: (...args: unknown[]) => mockRefuse(...args) };
});

import { queueChatDeletes, runDeletes } from "@/lib/chat/delete-runner";
import { CoderCleanupError } from "@/lib/coder/worktree-removal";
import { WORKTREE_KEPT_CODE } from "@/lib/coder/force-delete";

const USER_ID = "user-1";
const OTHER_USER = "user-2";

beforeEach(() => {
  vi.clearAllMocks();
  chats.clear();
  marked.clear();
  markedAtRemoval.length = 0;
  mockRefuse.mockResolvedValue(undefined);
  chats.set("chat-1", { userId: USER_ID, projectId: null });
  chats.set("chat-2", { userId: USER_ID, projectId: null });
});

describe("queueChatDeletes", () => {
  it("marks the chats and removes them in the background", async () => {
    const result = await queueChatDeletes(USER_ID, ["chat-1"]);

    expect(result).toEqual({ queued: ["chat-1"], failed: [] });

    await runDeletes();
    expect(mockDeleteChatSession).toHaveBeenCalledWith(USER_ID, "chat-1", false);
    // The mark is what the lists read, so it was there while the removal ran.
    expect(markedAtRemoval).toEqual([true]);
    expect(marked.has("chat-1")).toBe(false);
  });

  it("removes one chat at a time", async () => {
    await queueChatDeletes(USER_ID, ["chat-1", "chat-2"]);
    await runDeletes();

    expect(mockDeleteChatSession.mock.calls).toEqual([
      [USER_ID, "chat-1", false],
      [USER_ID, "chat-2", false],
    ]);
  });

  it("refuses a checkout holding work, before marking anything", async () => {
    chats.set("chat-1", { userId: USER_ID, projectId: "project-1" });
    mockRefuse.mockRejectedValue(
      new CoderCleanupError(
        "The branch wt/chat-1 has commits that exist nowhere else. Push them, or delete the checkout anyway.",
        409,
        WORKTREE_KEPT_CODE,
      ),
    );

    const result = await queueChatDeletes(USER_ID, ["chat-1"]);

    expect(result.queued).toEqual([]);
    expect(result.failed).toEqual([
      {
        sessionId: "chat-1",
        error:
          "The branch wt/chat-1 has commits that exist nowhere else. Push them, or delete the checkout anyway.",
        code: WORKTREE_KEPT_CODE,
      },
    ]);
    // The chat and its checkout survive, ready for the confirmed retry.
    expect(marked.has("chat-1")).toBe(false);
    await runDeletes();
    expect(mockDeleteChatSession).not.toHaveBeenCalled();
  });

  it("takes the user's word for it when they confirmed the discard", async () => {
    chats.set("chat-1", { userId: USER_ID, projectId: "project-1" });

    const result = await queueChatDeletes(USER_ID, ["chat-1"], true);

    expect(result).toEqual({ queued: ["chat-1"], failed: [] });
    expect(mockRefuse).not.toHaveBeenCalled();

    // The answer the user gave is what the removal runs with.
    await runDeletes();
    expect(mockDeleteChatSession).toHaveBeenCalledWith(USER_ID, "chat-1", true);
  });

  it("never asks about a checkout a normal chat does not have", async () => {
    await queueChatDeletes(USER_ID, ["chat-1"]);
    await runDeletes();

    expect(mockRefuse).not.toHaveBeenCalled();
  });

  it("reports a chat that is not the user's instead of failing the batch", async () => {
    chats.set("chat-2", { userId: OTHER_USER, projectId: null });

    const result = await queueChatDeletes(USER_ID, ["chat-1", "chat-2"]);

    expect(result.queued).toEqual(["chat-1"]);
    expect(result.failed).toEqual([{ sessionId: "chat-2", error: "Chat not found: chat-2" }]);

    await runDeletes();
    expect(mockDeleteChatSession).toHaveBeenCalledTimes(1);
  });

  it("counts a repeated id once", async () => {
    const result = await queueChatDeletes(USER_ID, ["chat-1", "chat-1"]);

    expect(result).toEqual({ queued: ["chat-1"], failed: [] });
    await runDeletes();
    expect(mockDeleteChatSession).toHaveBeenCalledTimes(1);
  });
});

describe("runDeletes", () => {
  it("puts the row back when a removal fails, so the chat can be tried again", async () => {
    mockDeleteChatSession.mockRejectedValueOnce(new Error("disk on fire"));

    await queueChatDeletes(USER_ID, ["chat-1"]);
    await runDeletes();

    expect(marked.has("chat-1")).toBe(false);
    // The chat is still there: nothing was half-deleted behind the failure.
    expect(chats.has("chat-1")).toBe(true);
  });

  it("carries on with the rest of the queue after a failure", async () => {
    mockDeleteChatSession.mockRejectedValueOnce(new Error("disk on fire"));

    await queueChatDeletes(USER_ID, ["chat-1", "chat-2"]);
    await runDeletes();

    expect(mockDeleteChatSession).toHaveBeenCalledTimes(2);
    expect(chats.has("chat-2")).toBe(false);
  });
});
