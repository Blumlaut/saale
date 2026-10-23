import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The sweep, run over a workspace whose directories do not all match the rows.
 *
 * A repo directory deleted by hand is the case that used to make every pass log
 * a failure: there is no git to ask, so the sweep only books the rows against
 * the disk.
 */

const mocks = vi.hoisted(() => ({
  findProjects: vi.fn(),
  findWorktrees: vi.fn(),
  updateWorktree: vi.fn(),
  listWorktrees: vi.fn(),
  pruneWorktrees: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    coderProject: { findMany: mocks.findProjects },
    coderWorktree: { findMany: mocks.findWorktrees, update: mocks.updateWorktree },
  },
}));

vi.mock("@/lib/coder/git", () => ({
  listWorktrees: mocks.listWorktrees,
  pruneWorktrees: mocks.pruneWorktrees,
}));

import { sweepWorktrees } from "@/lib/coder/sweep";
import { userIdentity } from "@/lib/sandbox/identity";

const USER = "u1";
const IDENTITY = userIdentity(USER);
let workspaceDir = "";

/** A directory inside the user's workspace. */
async function makeDir(relative: string): Promise<void> {
  await fs.mkdir(path.join(workspaceDir, IDENTITY, relative), { recursive: true });
}

beforeEach(async () => {
  vi.clearAllMocks();
  workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "saale-coder-sweep-"));
  vi.stubEnv("SANDBOX_WORKSPACES_DIR", workspaceDir);

  mocks.findProjects.mockResolvedValue([
    { id: "live", userId: USER, slug: "live", repoPath: "projects/live" },
    { id: "gone", userId: USER, slug: "gone", repoPath: "projects/gone" },
  ]);
  mocks.findWorktrees.mockResolvedValue([
    { sessionId: "chat-live", path: "worktrees/live/c-live", status: "active" },
    { sessionId: "chat-dead", path: "worktrees/gone/c-dead", status: "active" },
    { sessionId: "chat-gone", path: "worktrees/gone/c-gone", status: "removed" },
  ]);
  mocks.updateWorktree.mockResolvedValue({});
  mocks.listWorktrees.mockResolvedValue([]);
  mocks.pruneWorktrees.mockResolvedValue(undefined);

  await makeDir("projects/live");
  await makeDir("worktrees/live/c-live");
  await makeDir("worktrees/live/c-orphan");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(workspaceDir, { recursive: true, force: true });
});

describe("sweepWorktrees", () => {
  it("books a row whose checkout is gone as removed", async () => {
    const result = await sweepWorktrees();

    expect(result.forgotten).toBe(1);
    expect(mocks.updateWorktree).toHaveBeenCalledTimes(1);
    expect(mocks.updateWorktree).toHaveBeenCalledWith({
      where: { sessionId: "chat-dead" },
      data: { status: "removed", removedAt: expect.any(Date) },
    });
  });

  it("leaves a row whose checkout is there alone", async () => {
    await sweepWorktrees();

    expect(mocks.updateWorktree).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: { sessionId: "chat-live" } }),
    );
  });

  it("never asks git about a repo whose directory is missing", async () => {
    await sweepWorktrees();

    expect(mocks.listWorktrees).toHaveBeenCalledTimes(1);
    expect(mocks.listWorktrees).toHaveBeenCalledWith(USER, "projects/live");
  });

  it("reports a directory no row claims and removes nothing", async () => {
    const orphan = path.join(workspaceDir, IDENTITY, "worktrees/live/c-orphan");

    const result = await sweepWorktrees();

    expect(result.orphans).toEqual([orphan]);
    expect((await fs.stat(orphan)).isDirectory()).toBe(true);
  });

  it("does not call a checkout git still tracks an orphan", async () => {
    mocks.listWorktrees.mockResolvedValue([
      {
        path: path.join(workspaceDir, IDENTITY, "worktrees/live/c-orphan"),
        branch: "wt/c-orphan",
        relative: "worktrees/live/c-orphan",
      },
    ]);

    const result = await sweepWorktrees();

    expect(result.orphans).toEqual([]);
  });
});
