import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Removing what a coder chat owns.
 *
 * The rule under test is that git decides: a checkout with uncommitted work is
 * refused and the chat survives, and a project only loses its directory when
 * git can prove nothing is left behind.
 */

const mocks = vi.hoisted(() => ({
  findChat: vi.fn(),
  findProject: vi.fn(),
  findWorktree: vi.fn(),
  updateWorktree: vi.fn(),
  findManyProject: vi.fn(),
  deleteManyProject: vi.fn(),
  deleteChat: vi.fn(),
  getActiveSessions: vi.fn(),
  removeWorktree: vi.fn(),
  isRepoFullyPushed: vi.fn(),
  runInWorkspace: vi.fn(),
  pooledEntry: vi.fn(),
  removePooled: vi.fn(),
  getTerminalExecs: vi.fn(),
  killExec: vi.fn(),
  unregisterTerminalExec: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    chatSession: { findFirst: mocks.findChat },
    coderProject: {
      findFirst: mocks.findProject,
      findMany: mocks.findManyProject,
      deleteMany: mocks.deleteManyProject,
    },
    coderWorktree: { findUnique: mocks.findWorktree, update: mocks.updateWorktree },
  },
}));

vi.mock("@/lib/redis", () => ({
  getActiveSessions: mocks.getActiveSessions,
  getTerminalExecs: mocks.getTerminalExecs,
  unregisterTerminalExec: mocks.unregisterTerminalExec,
}));

vi.mock("@/lib/chat/delete-session", () => ({ deleteChatSession: mocks.deleteChat }));

vi.mock("@/lib/pi/agent-pool", () => ({
  getPoolKey: (userId: string, sessionId: string) => `${userId}:${sessionId}`,
  get: mocks.pooledEntry,
  remove: mocks.removePooled,
}));

vi.mock("@/lib/sandbox/client", () => ({
  kill: mocks.killExec,
  exec: vi.fn(),
  writeInput: vi.fn(),
}));

vi.mock("@/lib/coder/git", () => ({
  GitError: class FakeGitError extends Error {},
  removeWorktree: mocks.removeWorktree,
  isRepoFullyPushed: mocks.isRepoFullyPushed,
  runInWorkspace: mocks.runInWorkspace,
  shellQuote: (value: string) => `'${value}'`,
}));

import { GitError } from "@/lib/coder/git";
import { removeProject } from "@/lib/coder/cleanup";
import { CoderCleanupError, removeChatWorktree } from "@/lib/coder/worktree-removal";

const USER = "user-1";
const SESSION = "chat-1";

/** A real workspace directory, so a worktree can actually be there or not. */
let workspaceDir = "";
let originalWorkspacesDir: string | undefined;

beforeEach(async () => {
  originalWorkspacesDir = process.env.SANDBOX_WORKSPACES_DIR;
  workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "saale-coder-cleanup-"));
  process.env.SANDBOX_WORKSPACES_DIR = workspaceDir;

  vi.clearAllMocks();
  mocks.findChat.mockResolvedValue({ projectId: "project-1" });
  mocks.findProject.mockResolvedValue({ repoPath: "projects/saale", name: "saale" });
  mocks.findWorktree.mockResolvedValue({
    sessionId: SESSION,
    projectId: "project-1",
    path: "worktrees/saale/c-1a2b3c4d",
    branch: "wt/c-1a2b3c4d",
    status: "active",
  });
  mocks.removeWorktree.mockResolvedValue(undefined);
  mocks.updateWorktree.mockResolvedValue({});
  mocks.runInWorkspace.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
  mocks.pooledEntry.mockReturnValue(undefined);
  mocks.getActiveSessions.mockResolvedValue(new Set<string>());
  mocks.getTerminalExecs.mockResolvedValue(new Set<string>());
  mocks.killExec.mockResolvedValue(undefined);
  mocks.unregisterTerminalExec.mockResolvedValue(undefined);

  await fs.mkdir(path.join(workspaceDir, `user-${USER}`, "worktrees/saale/c-1a2b3c4d"), {
    recursive: true,
  });
});

afterEach(async () => {
  process.env.SANDBOX_WORKSPACES_DIR = originalWorkspacesDir;
  await fs.rm(workspaceDir, { recursive: true, force: true });
});

describe("removeChatWorktree", () => {
  it("removes a clean checkout without forcing it and forgets the row", async () => {
    const result = await removeChatWorktree(USER, SESSION);

    expect(result).toEqual({ path: "worktrees/saale/c-1a2b3c4d", removed: true });
    expect(mocks.removeWorktree).toHaveBeenCalledWith(USER, {
      repoDir: "projects/saale",
      dir: "worktrees/saale/c-1a2b3c4d",
    });
    expect(mocks.updateWorktree).toHaveBeenCalledWith({
      where: { sessionId: SESSION },
      data: { status: "removed", removedAt: expect.any(Date) },
    });
  });

  it("keeps the chat when git refuses a dirty worktree", async () => {
    mocks.removeWorktree.mockRejectedValue(
      new GitError("error: the working tree is dirty, use --force to remove", [], {
        stdout: "",
        stderr: "",
        exitCode: 1,
      }),
    );

    const error = await removeChatWorktree(USER, SESSION).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(CoderCleanupError);
    expect((error as CoderCleanupError).message).toContain("working tree is dirty");
    expect(mocks.updateWorktree).not.toHaveBeenCalled();
  });

  it("does nothing for a chat that is not a coder chat", async () => {
    mocks.findChat.mockResolvedValue({ projectId: null });
    expect(await removeChatWorktree(USER, SESSION)).toEqual({ path: null, removed: false });
    expect(mocks.removeWorktree).not.toHaveBeenCalled();
  });

  it("stops the commands the terminal started before anything else", async () => {
    mocks.getTerminalExecs.mockResolvedValue(new Set(["exec-1", "exec-2"]));

    await removeChatWorktree(USER, SESSION);

    expect(mocks.getTerminalExecs).toHaveBeenCalledWith(USER, SESSION);
    expect(mocks.killExec.mock.calls.map(([id]) => id)).toEqual(["exec-1", "exec-2"]);
    expect(mocks.unregisterTerminalExec).toHaveBeenCalledWith(USER, SESSION, "exec-1");
  });

  it("still removes the checkout when a terminal command refuses to die", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.getTerminalExecs.mockResolvedValue(new Set(["gone"]));
    mocks.killExec.mockRejectedValueOnce(new Error("No running command gone"));

    const result = await removeChatWorktree(USER, SESSION);

    expect(result.removed).toBe(true);
    expect(mocks.removeWorktree).toHaveBeenCalled();
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it("kills what is still running in the worktree first", async () => {
    await removeChatWorktree(USER, SESSION);

    expect(mocks.runInWorkspace).toHaveBeenCalledWith(USER, {
      cwd: ".",
      command: expect.stringContaining("pkill -f"),
    });
    const command = (mocks.runInWorkspace.mock.calls[0]?.[1] as { command: string }).command;
    expect(command).toContain("c-1a2b3c4d");
  });

  it("only forgets the row when the checkout is already gone", async () => {
    await fs.rm(path.join(workspaceDir, `user-${USER}`, "worktrees"), { recursive: true });

    const result = await removeChatWorktree(USER, SESSION);

    expect(result).toEqual({ path: "worktrees/saale/c-1a2b3c4d", removed: true });
    expect(mocks.removeWorktree).not.toHaveBeenCalled();
    expect(mocks.updateWorktree).toHaveBeenCalled();
  });

  it("does nothing for a worktree that was already removed", async () => {
    mocks.findWorktree.mockResolvedValue({
      sessionId: SESSION,
      projectId: "project-1",
      path: "worktrees/saale/c-1a2b3c4d",
      branch: "wt/c-1a2b3c4d",
      status: "removed",
    });
    expect(await removeChatWorktree(USER, SESSION)).toEqual({ path: null, removed: false });
    expect(mocks.removeWorktree).not.toHaveBeenCalled();
  });

  it("refuses when the repo is gone, so the files are not the last copy lost", async () => {
    mocks.findProject.mockResolvedValue(null);
    await expect(removeChatWorktree(USER, SESSION)).rejects.toBeInstanceOf(CoderCleanupError);
  });
});

describe("removeProject", () => {
  beforeEach(() => {
    mocks.findProject.mockResolvedValue({
      id: "project-1",
      name: "saale",
      repoPath: "projects/saale",
      chats: [{ id: SESSION }],
    });
  });

  it("refuses while one of its chats is generating", async () => {
    mocks.getActiveSessions.mockResolvedValue(new Set([SESSION]));

    await expect(removeProject(USER, "project-1")).rejects.toThrow(/generating/i);
    expect(mocks.deleteChat).not.toHaveBeenCalled();
    expect(mocks.deleteManyProject).not.toHaveBeenCalled();
  });

  it("refuses a repo with work that exists nowhere else", async () => {
    mocks.isRepoFullyPushed.mockResolvedValue(false);

    await expect(removeProject(USER, "project-1")).rejects.toThrow(/not pushed|uncommitted/i);
    expect(mocks.deleteChat).not.toHaveBeenCalled();
    // Only the process kill ran; the repo directory is untouched.
    expect(
      mocks.runInWorkspace.mock.calls.some((call) =>
        String((call[1] as { command: string }).command).includes("rm -rf"),
      ),
    ).toBe(false);
  });

  it("removes the worktrees, the chats, the directory and the row", async () => {
    mocks.isRepoFullyPushed.mockResolvedValue(true);

    await removeProject(USER, "project-1");

    expect(mocks.removeWorktree).toHaveBeenCalledTimes(1);
    expect(mocks.deleteChat).toHaveBeenCalledWith(USER, SESSION);
    expect(mocks.runInWorkspace).toHaveBeenCalledWith(USER, {
      cwd: ".",
      command: "rm -rf -- 'projects/saale'",
    });
    expect(mocks.deleteManyProject).toHaveBeenCalledWith({
      where: { id: "project-1", userId: USER },
    });
  });

  it("stops before deleting anything when a worktree refuses", async () => {
    mocks.isRepoFullyPushed.mockResolvedValue(true);
    mocks.removeWorktree.mockRejectedValue(
      new GitError("error: contains modified content", [], { stdout: "", stderr: "", exitCode: 1 }),
    );

    await expect(removeProject(USER, "project-1")).rejects.toBeInstanceOf(CoderCleanupError);
    expect(mocks.deleteChat).not.toHaveBeenCalled();
    expect(mocks.deleteManyProject).not.toHaveBeenCalled();
  });

  it("reports a project that is not this user's as missing", async () => {
    mocks.findProject.mockResolvedValue(null);
    await expect(removeProject(USER, "other-project")).rejects.toMatchObject({ status: 404 });
  });
});
