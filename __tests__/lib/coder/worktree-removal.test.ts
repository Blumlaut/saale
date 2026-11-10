import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * What a delete of a coder chat's checkout is allowed to throw away.
 *
 * The decision is asked twice: once before the chat is marked (so the box can
 * ask while the chat is still whole) and again by the removal itself. Both go
 * through the same rules, and every refusal carries the code that a confirmed
 * retry overrides.
 */

const state = {
  session: { projectId: "project-1" as string | null } as { projectId: string | null } | null,
  project: { repoPath: "projects/saale" } as { repoPath: string } | null,
  worktree: { path: "worktrees/saale/c-1", branch: "wt/c-1", status: "active" } as {
    path: string;
    branch: string;
    status: string;
  } | null,
  repoExists: true,
  checkoutExists: true,
};

vi.mock("@/lib/db", () => ({
  prisma: {
    chatSession: { findFirst: async () => state.session },
    coderProject: { findFirst: async () => state.project },
    coderWorktree: {
      findUnique: async () => state.worktree,
      update: async () => ({}),
    },
  },
}));

const mockStatus = vi.fn();
const mockPushed = vi.fn();
const mockRemoveWorktree = vi.fn();
const mockDeleteBranch = vi.fn();
const mockDeleteDirectory = vi.fn();

vi.mock("@/lib/coder/git", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/coder/git")>();
  return {
    ...actual,
    readStatus: (...args: unknown[]) => mockStatus(...args),
    isBranchPushed: (...args: unknown[]) => mockPushed(...args),
    removeWorktree: (...args: unknown[]) => mockRemoveWorktree(...args),
    deleteBranch: (...args: unknown[]) => mockDeleteBranch(...args),
    deleteWorktreeDirectory: (...args: unknown[]) => mockDeleteDirectory(...args),
  };
});

vi.mock("@/lib/coder/paths", () => ({
  workspaceDirectoryExists: async (_userId: string, dir: string) =>
    dir === "projects/saale" ? state.repoExists : state.checkoutExists,
  resolveCoderPath: (_userId: string, dir: string) => `/w/user/worktrees/${dir}`,
}));

const mockStopChatProcesses = vi.fn();
vi.mock("@/lib/coder/processes", () => ({
  stopChatProcesses: (...args: unknown[]) => mockStopChatProcesses(...args),
}));

vi.mock("@/lib/pi/agent-pool", () => ({
  getPoolKey: (userId: string, sessionId: string) => `${userId}:${sessionId}`,
  get: () => null,
  remove: async () => {},
}));

import {
  refuseChatWorktreeDelete,
  removeChatWorktree,
  CoderCleanupError,
} from "@/lib/coder/worktree-removal";
import { WORKTREE_KEPT_CODE } from "@/lib/coder/force-delete";

const USER = "user-1";
const CHAT = "chat-1";

/** The refusal a plain delete would throw, if any. */
async function refusal(): Promise<CoderCleanupError | null> {
  try {
    await refuseChatWorktreeDelete(USER, CHAT);
    return null;
  } catch (err) {
    if (err instanceof CoderCleanupError) return err;
    throw err;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  state.session = { projectId: "project-1" };
  state.project = { repoPath: "projects/saale" };
  state.worktree = { path: "worktrees/saale/c-1", branch: "wt/c-1", status: "active" };
  state.repoExists = true;
  state.checkoutExists = true;
  mockStatus.mockResolvedValue({ branch: "wt/c-1", files: [] });
  mockPushed.mockResolvedValue(true);
  mockRemoveWorktree.mockResolvedValue(undefined);
  mockDeleteBranch.mockResolvedValue(undefined);
  mockDeleteDirectory.mockResolvedValue(undefined);
  mockStopChatProcesses.mockResolvedValue(undefined);
});

describe("refuseChatWorktreeDelete", () => {
  it("lets a clean, pushed checkout go without a word", async () => {
    expect(await refusal()).toBeNull();
  });

  it("keeps a branch holding commits nothing else has", async () => {
    mockPushed.mockResolvedValue(false);

    const err = await refusal();

    expect(err?.code).toBe(WORKTREE_KEPT_CODE);
    expect(err?.message).toContain("wt/c-1");
    expect(err?.message).toContain("exist nowhere else");
  });

  it("asks about the branch the checkout was switched to as well", async () => {
    mockStatus.mockResolvedValue({ branch: "wt/reviewed", files: [] });
    mockPushed.mockImplementation(async (_user: string, _repo: string, branch: string) => {
      return branch !== "wt/reviewed";
    });

    const err = await refusal();

    expect(err?.code).toBe(WORKTREE_KEPT_CODE);
    expect(err?.message).toContain("wt/reviewed");
  });

  it("keeps uncommitted changes", async () => {
    mockStatus.mockResolvedValue({ branch: "wt/c-1", files: [{ path: "src/a.ts" }] });

    const err = await refusal();

    expect(err?.code).toBe(WORKTREE_KEPT_CODE);
    expect(err?.message).toContain("never committed");
  });

  it("keeps a checkout git no longer knows, whose files are all that is left", async () => {
    mockStatus.mockRejectedValue(new Error("fatal: not a git repository"));

    const err = await refusal();

    expect(err?.code).toBe(WORKTREE_KEPT_CODE);
    expect(err?.message).toContain("not a git worktree any more");
  });

  it("keeps the checkout when its repo is gone", async () => {
    state.repoExists = false;

    const err = await refusal();

    expect(err?.code).toBe(WORKTREE_KEPT_CODE);
    expect(err?.message).toContain("its files may be the only copy");
  });

  it("has nothing to ask about a normal chat", async () => {
    state.session = { projectId: null };

    expect(await refusal()).toBeNull();
    expect(mockStatus).not.toHaveBeenCalled();
  });

  it("has nothing to ask about a chat whose checkout is already gone", async () => {
    state.worktree = { path: "worktrees/saale/c-1", branch: "wt/c-1", status: "removed" };

    expect(await refusal()).toBeNull();
  });
});

describe("removeChatWorktree", () => {
  it("refuses before stopping anything the chat left running", async () => {
    mockStatus.mockResolvedValue({ branch: "wt/c-1", files: [{ path: "src/a.ts" }] });

    await expect(removeChatWorktree(USER, CHAT)).rejects.toThrow(/never committed/);
    // Nothing was killed for a delete that did not happen.
    expect(mockStopChatProcesses).not.toHaveBeenCalled();
    expect(mockRemoveWorktree).not.toHaveBeenCalled();
  });

  it("removes a checkout git does not know once the user confirmed", async () => {
    mockStatus.mockRejectedValue(new Error("fatal: not a git repository"));

    const result = await removeChatWorktree(USER, CHAT, true);

    expect(result).toEqual({ path: "worktrees/saale/c-1", removed: true });
    // git cannot remove what it does not manage, so the directory goes itself.
    expect(mockRemoveWorktree).toHaveBeenCalledWith(USER, {
      repoDir: "projects/saale",
      dir: "worktrees/saale/c-1",
      force: true,
    });
  });

  it("removes the directory outright when the repo is gone and the user confirmed", async () => {
    state.repoExists = false;

    await removeChatWorktree(USER, CHAT, true);

    expect(mockDeleteDirectory).toHaveBeenCalledWith(USER, "worktrees/saale/c-1");
    expect(mockRemoveWorktree).not.toHaveBeenCalled();
  });
});
