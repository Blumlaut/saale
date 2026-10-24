import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * What happens to a bot chat once its run is over.
 *
 * Every case here is the same question: is the work in this checkout somewhere
 * else yet? A clean pushed branch is a copy of work git already has; anything
 * else is the only place that work exists.
 */

vi.mock("@/lib/db", () => ({
  prisma: {
    scriptWatcher: { findMany: vi.fn() },
    chatSession: { findMany: vi.fn() },
  },
}));

vi.mock("@/lib/chat/delete-session", () => ({ deleteChatSession: vi.fn() }));

vi.mock("@/lib/coder/git", () => ({
  isBranchPushed: vi.fn(),
  readStatus: vi.fn(),
}));

vi.mock("@/lib/coder/paths", () => ({
  workspaceDirectoryExists: vi.fn(),
}));

vi.mock("@/lib/redis", () => ({ getActiveSessions: vi.fn() }));

import { prisma } from "@/lib/db";
import { deleteChatSession } from "@/lib/chat/delete-session";
import { isBranchPushed, readStatus } from "@/lib/coder/git";
import { workspaceDirectoryExists } from "@/lib/coder/paths";
import { getActiveSessions } from "@/lib/redis";
import { CoderCleanupError } from "@/lib/coder/worktree-removal";
import { sweepWatcherChats } from "@/lib/watchers/retention";

/* eslint-disable @typescript-eslint/no-explicit-any */
const findWatchers = vi.mocked(prisma.scriptWatcher.findMany as any);
const findChats = vi.mocked(prisma.chatSession.findMany as any);
const remove = vi.mocked(deleteChatSession as any);
const pushed = vi.mocked(isBranchPushed as any);
const status = vi.mocked(readStatus as any);
const dirExists = vi.mocked(workspaceDirectoryExists as any);
const active = vi.mocked(getActiveSessions as any);
/* eslint-enable @typescript-eslint/no-explicit-any */

/** A per-fire bot chat with the worktree it runs in. */
function botChat(id = "chat-1") {
  return {
    id,
    coderWorktree: {
      path: `worktrees/saale-web/${id}`,
      branch: `watch/pr-bot/${id}`,
      status: "active",
    },
  };
}

describe("sweepWatcherChats", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findWatchers.mockResolvedValue([
      { id: "w-1", userId: "u-1", name: "PR bot", retentionMinutes: 60 },
    ]);
    findChats.mockResolvedValue([botChat()]);
    dirExists.mockResolvedValue(true);
    status.mockResolvedValue({ files: [] });
    pushed.mockResolvedValue(true);
    active.mockResolvedValue(new Set<string>());
    remove.mockResolvedValue({ title: "PR bot" });
  });

  it("removes a finished per-fire chat past its window", async () => {
    const result = await sweepWatcherChats();

    expect(result.removed).toEqual(["chat-1"]);
    expect(remove).toHaveBeenCalledWith("u-1", "chat-1");
  });

  it("only looks at chats past the watcher's retention window", async () => {
    await sweepWatcherChats();

    const cutoff = findChats.mock.calls[0]?.[0]?.where?.lastActivityAt?.lt as Date;
    const age = Date.now() - cutoff.getTime();
    expect(age).toBeGreaterThanOrEqual(59 * 60_000);
    expect(age).toBeLessThanOrEqual(61 * 60_000);
  });

  it("keeps a checkout with uncommitted work", async () => {
    status.mockResolvedValue({ files: [{ path: "src/index.ts" }] });

    const result = await sweepWatcherChats();

    expect(result.removed).toEqual([]);
    expect(result.kept).toBe(1);
    expect(remove).not.toHaveBeenCalled();
  });

  it("keeps a clean checkout whose commits are nowhere else", async () => {
    pushed.mockResolvedValue(false);

    const result = await sweepWatcherChats();

    expect(result.removed).toEqual([]);
    expect(remove).not.toHaveBeenCalled();
  });

  it("keeps a chat that is generating right now", async () => {
    active.mockResolvedValue(new Set(["chat-1"]));

    const result = await sweepWatcherChats();

    expect(result.removed).toEqual([]);
    expect(result.kept).toBe(1);
    expect(status).not.toHaveBeenCalled();
  });

  it("keeps a chat when git refuses to let the checkout go", async () => {
    remove.mockRejectedValue(new CoderCleanupError("worktree is dirty"));

    const result = await sweepWatcherChats();

    expect(result.removed).toEqual([]);
    expect(result.kept).toBe(1);
  });

  it("removes a chat whose checkout is already gone", async () => {
    dirExists.mockResolvedValue(false);

    const result = await sweepWatcherChats();

    expect(result.removed).toEqual(["chat-1"]);
    expect(status).not.toHaveBeenCalled();
  });

  it("leaves a watcher alone when it has no chats past the window", async () => {
    findChats.mockResolvedValue([]);

    const result = await sweepWatcherChats();

    expect(result).toEqual({ removed: [], kept: 0 });
  });
});
