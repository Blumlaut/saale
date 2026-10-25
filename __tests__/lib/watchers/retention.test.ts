import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Retiring a bot chat.
 *
 * Which chats are due is this module's whole job. What may happen to the
 * checkout, the branch and the work in them belongs to `deleteChatSession` and
 * `removeChatWorktree`, and their refusal is a chat that stays.
 */

vi.mock("@/lib/db", () => ({
  prisma: {
    scriptWatcher: { findMany: vi.fn() },
    chatSession: { findMany: vi.fn() },
  },
}));

vi.mock("@/lib/chat/delete-session", () => ({ deleteChatSession: vi.fn() }));

vi.mock("@/lib/redis", () => ({ getActiveSessions: vi.fn() }));

import { prisma } from "@/lib/db";
import { deleteChatSession } from "@/lib/chat/delete-session";
import { getActiveSessions } from "@/lib/redis";
import { WORKTREE_KEPT_CODE } from "@/lib/coder/force-delete";
import { CoderCleanupError } from "@/lib/coder/worktree-removal";
import { sweepWatcherChats } from "@/lib/watchers/retention";

/* eslint-disable @typescript-eslint/no-explicit-any */
const findWatchers = vi.mocked(prisma.scriptWatcher.findMany as any);
const findChats = vi.mocked(prisma.chatSession.findMany as any);
const remove = vi.mocked(deleteChatSession as any);
const active = vi.mocked(getActiveSessions as any);
/* eslint-enable @typescript-eslint/no-explicit-any */

describe("sweepWatcherChats", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findWatchers.mockResolvedValue([
      { id: "w-1", userId: "u-1", name: "PR bot", retentionMinutes: 60 },
    ]);
    findChats.mockResolvedValue([{ id: "chat-1" }]);
    active.mockResolvedValue(new Set<string>());
    remove.mockResolvedValue({ title: "PR bot" });
  });

  it("removes a per-fire chat past its window", async () => {
    const result = await sweepWatcherChats();

    expect(result).toEqual({ removed: ["chat-1"], kept: 0 });
    expect(remove).toHaveBeenCalledWith("u-1", "chat-1");
  });

  it("only looks at chats past the watcher's retention window", async () => {
    await sweepWatcherChats();

    const cutoff = findChats.mock.calls[0]?.[0]?.where?.lastActivityAt?.lt as Date;
    const age = Date.now() - cutoff.getTime();
    expect(age).toBeGreaterThanOrEqual(59 * 60_000);
    expect(age).toBeLessThanOrEqual(61 * 60_000);
  });

  it("only looks at the chats this watcher opened", async () => {
    await sweepWatcherChats();

    expect(findChats.mock.calls[0]?.[0]?.where).toMatchObject({
      userId: "u-1",
      origin: "watcher",
      originId: "w-1",
    });
  });

  it("keeps a chat that is generating right now", async () => {
    active.mockResolvedValue(new Set(["chat-1"]));

    const result = await sweepWatcherChats();

    expect(result).toEqual({ removed: [], kept: 1 });
    expect(remove).not.toHaveBeenCalled();
  });

  it("keeps a chat whose checkout holds work that exists nowhere else", async () => {
    remove.mockRejectedValue(new CoderCleanupError("worktree is dirty", 409, WORKTREE_KEPT_CODE));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await sweepWatcherChats();

    expect(result).toEqual({ removed: [], kept: 1 });
    // A kept checkout is the expected answer, not something to log as a fault.
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it("keeps the chat and says so when the delete broke on something else", async () => {
    remove.mockRejectedValue(new Error("database is down"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await sweepWatcherChats();

    expect(result).toEqual({ removed: [], kept: 1 });
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it("leaves a watcher alone when it has no chats past the window", async () => {
    findChats.mockResolvedValue([]);

    const result = await sweepWatcherChats();

    expect(result).toEqual({ removed: [], kept: 0 });
  });
});
