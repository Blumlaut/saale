import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Prisma } from "@prisma/client";

/**
 * A coder chat's worktree, built before its agent exists.
 *
 * The row and git can disagree (a directory deleted by hand, a checkout git
 * still lists), so the rule the panel and the agent both depend on is pinned
 * here: the row wins on the path and the branch, and git is asked whether the
 * checkout is actually there.
 */

const mocks = vi.hoisted(() => {
  class MockGitError extends Error {
    readonly args: readonly string[];
    readonly result: { stdout: string; stderr: string; exitCode: number };

    constructor(message: string) {
      super(message);
      this.name = "GitError";
      this.args = [];
      this.result = { stdout: "", stderr: message, exitCode: 128 };
    }
  }

  return {
    MockGitError,
    findChat: vi.fn(),
    findProject: vi.fn(),
    findWorktree: vi.fn(),
    createWorktree: vi.fn(),
    addWorktree: vi.fn(),
    addWorktreeOnBranch: vi.fn(),
    headSha: vi.fn(),
    listWorktrees: vi.fn(),
    pruneWorktrees: vi.fn(),
    removeWorktree: vi.fn(),
    runGit: vi.fn(),
    getPooled: vi.fn(),
    removePooled: vi.fn(),
  };
});

vi.mock("@/lib/db", () => ({
  prisma: {
    chatSession: { findFirst: (...args: unknown[]) => mocks.findChat(...args) },
    coderProject: { findFirst: (...args: unknown[]) => mocks.findProject(...args) },
    coderWorktree: {
      findUnique: (...args: unknown[]) => mocks.findWorktree(...args),
      create: (...args: unknown[]) => mocks.createWorktree(...args),
    },
  },
}));

vi.mock("@/lib/coder/git", () => ({
  GitError: mocks.MockGitError,
  addWorktree: (...args: unknown[]) => mocks.addWorktree(...args),
  addWorktreeOnBranch: (...args: unknown[]) => mocks.addWorktreeOnBranch(...args),
  headSha: (...args: unknown[]) => mocks.headSha(...args),
  listWorktrees: (...args: unknown[]) => mocks.listWorktrees(...args),
  pruneWorktrees: (...args: unknown[]) => mocks.pruneWorktrees(...args),
  removeWorktree: (...args: unknown[]) => mocks.removeWorktree(...args),
  runGit: (...args: unknown[]) => mocks.runGit(...args),
}));

vi.mock("@/lib/pi/agent-pool", () => ({
  getPoolKey: (userId: string, sessionId: string) => `${userId}:${sessionId}`,
  get: (...args: unknown[]) => mocks.getPooled(...args),
  remove: (...args: unknown[]) => mocks.removePooled(...args),
}));

import { ensureWorktree } from "@/lib/coder/worktrees";

const USER = "user-1";
const PROJECT = {
  id: "proj-1",
  slug: "saale",
  repoPath: "projects/saale",
  defaultBranch: "main",
};

let workspaceRoot: string;

/** The directory `sessionId`'s worktree is checked out at. */
function worktreeDir(sessionId: string): string {
  const chat = `c-${sessionId
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase()
    .slice(0, 8)}`;
  return path.join(workspaceRoot, "user-user-1", "worktrees", "saale", chat);
}

/**
 * Stand-in for git, which creates the checkout at the path it was given. The
 * directory is what the existence check looks for.
 */
async function createsCheckout(_user: string, options: { dir: string }): Promise<void> {
  await fs.mkdir(path.join(workspaceRoot, "user-user-1", options.dir), { recursive: true });
}

beforeEach(async () => {
  vi.clearAllMocks();
  workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "saale-worktrees-"));
  vi.stubEnv("SANDBOX_WORKSPACES_DIR", workspaceRoot);

  mocks.findChat.mockResolvedValue({ id: "chat-1", projectId: PROJECT.id });
  mocks.findProject.mockResolvedValue(PROJECT);
  mocks.findWorktree.mockResolvedValue(null);
  mocks.createWorktree.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: "wt-1",
    status: "active",
    removedAt: null,
    createdAt: new Date(),
    ...data,
  }));
  mocks.addWorktree.mockImplementation(createsCheckout);
  mocks.addWorktreeOnBranch.mockImplementation(createsCheckout);
  mocks.headSha.mockResolvedValue("sha-base");
  mocks.listWorktrees.mockResolvedValue([]);
  mocks.pruneWorktrees.mockResolvedValue(undefined);
  mocks.removeWorktree.mockResolvedValue(undefined);
  mocks.runGit.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
  mocks.getPooled.mockReturnValue(undefined);
  mocks.removePooled.mockResolvedValue(undefined);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(workspaceRoot, { recursive: true, force: true });
});

describe("ensureWorktree", () => {
  it("returns an existing row whose directory is still there without touching git", async () => {
    mocks.findWorktree.mockResolvedValue({
      id: "wt-1",
      projectId: PROJECT.id,
      sessionId: "chat-1",
      path: "worktrees/saale/c-chat1",
      branch: "wt/c-chat1",
      baseSha: "sha-base",
    });
    await fs.mkdir(worktreeDir("chat-1"), { recursive: true });

    const worktree = await ensureWorktree(USER, "chat-1");

    expect(worktree).toEqual({ path: "worktrees/saale/c-chat1", branch: "wt/c-chat1" });
    expect(mocks.addWorktree).not.toHaveBeenCalled();
    expect(mocks.headSha).not.toHaveBeenCalled();
    expect(mocks.pruneWorktrees).not.toHaveBeenCalled();
    // Nothing changed, so the pooled agent keeps its cwd.
    expect(mocks.removePooled).not.toHaveBeenCalled();
  });

  it("recreates a row whose directory went away at the same path and branch", async () => {
    mocks.findWorktree.mockResolvedValue({
      id: "wt-1",
      projectId: PROJECT.id,
      sessionId: "chat-1",
      path: "worktrees/saale/c-chat1",
      branch: "wt/c-chat1",
      baseSha: "sha-start",
    });

    const worktree = await ensureWorktree(USER, "chat-1");

    expect(worktree).toEqual({ path: "worktrees/saale/c-chat1", branch: "wt/c-chat1" });
    expect(mocks.pruneWorktrees).toHaveBeenCalledWith(USER, "projects/saale");
    expect(mocks.addWorktree).toHaveBeenCalledWith(USER, {
      repoDir: "projects/saale",
      dir: "worktrees/saale/c-chat1",
      branch: "wt/c-chat1",
      base: "sha-start",
    });
    expect(mocks.createWorktree).not.toHaveBeenCalled();
  });

  it("creates a new branch off the default branch and records where it started", async () => {
    mocks.headSha.mockResolvedValue("sha-head");

    const worktree = await ensureWorktree(USER, "chat-1");

    expect(worktree).toEqual({ path: "worktrees/saale/c-chat1", branch: "wt/c-chat1" });
    expect(mocks.addWorktree).toHaveBeenCalledWith(USER, {
      repoDir: "projects/saale",
      dir: "worktrees/saale/c-chat1",
      branch: "wt/c-chat1",
      base: "main",
    });
    expect(mocks.createWorktree).toHaveBeenCalledWith({
      data: {
        projectId: PROJECT.id,
        sessionId: "chat-1",
        path: "worktrees/saale/c-chat1",
        branch: "wt/c-chat1",
        baseSha: "sha-head",
      },
    });
  });

  it("gives two chats in one project distinct paths and branches", async () => {
    mocks.findChat.mockImplementation(async ({ where }: { where: { id: string } }) => ({
      id: where.id,
      projectId: PROJECT.id,
    }));

    const first = await ensureWorktree(USER, "chat-1");
    const second = await ensureWorktree(USER, "chat-2");

    expect(first.path).not.toBe(second.path);
    expect(first.branch).not.toBe(second.branch);
    expect(first.branch).toBe("wt/c-chat1");
    expect(second.branch).toBe("wt/c-chat2");
    expect(mocks.createWorktree).toHaveBeenCalledTimes(2);
  });

  it("refuses a project that belongs to someone else", async () => {
    mocks.findProject.mockResolvedValue(null);

    await expect(ensureWorktree(USER, "chat-1")).rejects.toThrow(/Project not found/);

    // The lookup is scoped by user, so another user's project id resolves to nothing.
    expect(mocks.findProject).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: PROJECT.id, userId: USER } }),
    );
    expect(mocks.addWorktree).not.toHaveBeenCalled();
  });

  it("refuses a chat that belongs to someone else", async () => {
    mocks.findChat.mockResolvedValue(null);

    await expect(ensureWorktree(USER, "chat-1")).rejects.toThrow(/Chat not found/);
    expect(mocks.findProject).not.toHaveBeenCalled();
  });

  it("refuses a chat that is not in a project", async () => {
    mocks.findChat.mockResolvedValue({ id: "chat-1", projectId: null });

    await expect(ensureWorktree(USER, "chat-1")).rejects.toThrow(/does not belong to a project/);
    expect(mocks.addWorktree).not.toHaveBeenCalled();
  });

  it("checks out the existing branch when the worktree's branch outlived its checkout", async () => {
    mocks.findWorktree.mockResolvedValue({
      id: "wt-1",
      projectId: PROJECT.id,
      sessionId: "chat-1",
      path: "worktrees/saale/c-chat1",
      branch: "wt/c-chat1",
      baseSha: "sha-start",
    });
    mocks.addWorktree.mockRejectedValue(
      new mocks.MockGitError("fatal: a branch named 'wt/c-chat1' already exists"),
    );

    const worktree = await ensureWorktree(USER, "chat-1");

    expect(worktree.branch).toBe("wt/c-chat1");
    expect(mocks.addWorktreeOnBranch).toHaveBeenCalledWith(USER, {
      repoDir: "projects/saale",
      dir: "worktrees/saale/c-chat1",
      branch: "wt/c-chat1",
      base: "sha-start",
    });
  });

  it("moves a branch git still has checked out at another path", async () => {
    mocks.findWorktree.mockResolvedValue({
      id: "wt-1",
      projectId: PROJECT.id,
      sessionId: "chat-1",
      path: "worktrees/saale/c-chat1",
      branch: "wt/c-chat1",
      baseSha: "sha-start",
    });
    mocks.addWorktree.mockRejectedValue(
      new mocks.MockGitError("fatal: a branch named 'wt/c-chat1' already exists"),
    );
    mocks.listWorktrees.mockResolvedValue([
      { path: `${workspaceRoot}/user-user-1/projects/saale`, branch: "main", main: true },
      {
        path: `${workspaceRoot}/user-user-1/projects/saale/worktrees/saale/c-chat1`,
        branch: "wt/c-chat1",
        relative: "projects/saale/worktrees/saale/c-chat1",
      },
    ]);

    await ensureWorktree(USER, "chat-1");

    expect(mocks.removeWorktree).toHaveBeenCalledWith(USER, {
      repoDir: "projects/saale",
      dir: "projects/saale/worktrees/saale/c-chat1",
    });
    expect(mocks.addWorktreeOnBranch).toHaveBeenCalledTimes(1);
  });

  it("refuses to hand out a worktree git did not create", async () => {
    mocks.addWorktree.mockResolvedValue(undefined);

    await expect(ensureWorktree(USER, "chat-1")).rejects.toThrow(/was not created/);
    expect(mocks.createWorktree).not.toHaveBeenCalled();
  });

  it("retries once when another git process holds a lock", async () => {
    mocks.addWorktree
      .mockRejectedValueOnce(new mocks.MockGitError("fatal: cannot lock ref 'HEAD'"))
      .mockImplementationOnce(createsCheckout);

    const worktree = await ensureWorktree(USER, "chat-1");

    expect(worktree.branch).toBe("wt/c-chat1");
    expect(mocks.addWorktree).toHaveBeenCalledTimes(2);
  });

  it("gives up on a failure that is not a lock, without creating anything", async () => {
    mocks.addWorktree.mockRejectedValue(new mocks.MockGitError("fatal: invalid reference: main"));

    await expect(ensureWorktree(USER, "chat-1")).rejects.toThrow(/invalid reference/);

    expect(mocks.addWorktree).toHaveBeenCalledTimes(1);
    expect(mocks.createWorktree).not.toHaveBeenCalled();
    expect(mocks.removePooled).not.toHaveBeenCalled();
  });

  it("re-reads the row when a racing process created it first", async () => {
    mocks.createWorktree.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "test",
      }),
    );
    mocks.findWorktree.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: "wt-raced",
      projectId: PROJECT.id,
      sessionId: "chat-1",
      path: "worktrees/saale/c-chat1",
      branch: "wt/c-chat1",
      baseSha: "sha-head",
    });

    const worktree = await ensureWorktree(USER, "chat-1");

    expect(worktree).toEqual({ path: "worktrees/saale/c-chat1", branch: "wt/c-chat1" });
    expect(mocks.addWorktree).toHaveBeenCalledTimes(1);
  });

  it("evicts the pooled agent when the worktree was just built", async () => {
    mocks.getPooled.mockReturnValue({ session: {} });

    await ensureWorktree(USER, "chat-1");

    expect(mocks.removePooled).toHaveBeenCalledWith("user-1:chat-1");
  });

  it("serializes worktree creation within one project", async () => {
    mocks.findChat.mockImplementation(async ({ where }: { where: { id: string } }) => ({
      id: where.id,
      projectId: PROJECT.id,
    }));
    let running = 0;
    let peak = 0;
    mocks.addWorktree.mockImplementation(async (user: string, options: { dir: string }) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      await createsCheckout(user, options);
    });

    await Promise.all([
      ensureWorktree(USER, "chat-1"),
      ensureWorktree(USER, "chat-2"),
      ensureWorktree(USER, "chat-3"),
    ]);

    expect(peak).toBe(1);
  });
});
