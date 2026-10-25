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
  deleteWorktreeDirectory: vi.fn(),
  isRepoFullyPushed: vi.fn(),
  isBranchPushed: vi.fn(),
  deleteBranch: vi.fn(),
  readStatus: vi.fn(),
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
  deleteWorktreeDirectory: mocks.deleteWorktreeDirectory,
  isRepoFullyPushed: mocks.isRepoFullyPushed,
  isBranchPushed: mocks.isBranchPushed,
  deleteBranch: mocks.deleteBranch,
  readStatus: mocks.readStatus,
  runInWorkspace: mocks.runInWorkspace,
  shellQuote: (value: string) => `'${value}'`,
}));

import { GitError } from "@/lib/coder/git";
import { WORKTREE_KEPT_CODE } from "@/lib/coder/force-delete";
import { removeProject } from "@/lib/coder/cleanup";
import { CoderCleanupError, removeChatWorktree } from "@/lib/coder/worktree-removal";
import { userIdentity } from "@/lib/sandbox/identity";

const USER = "user-1";
const IDENTITY = userIdentity(USER);
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
  mocks.isBranchPushed.mockResolvedValue(true);
  mocks.deleteBranch.mockResolvedValue(undefined);
  mocks.readStatus.mockResolvedValue({ files: [], branch: "wt/c-1a2b3c4d" });
  mocks.findProject.mockResolvedValue({ repoPath: "projects/saale", name: "saale" });
  mocks.findWorktree.mockResolvedValue({
    sessionId: SESSION,
    projectId: "project-1",
    path: "worktrees/saale/c-1a2b3c4d",
    branch: "wt/c-1a2b3c4d",
    status: "active",
  });
  mocks.removeWorktree.mockResolvedValue(undefined);
  mocks.deleteWorktreeDirectory.mockResolvedValue(undefined);
  mocks.updateWorktree.mockResolvedValue({});
  mocks.runInWorkspace.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
  mocks.pooledEntry.mockReturnValue(undefined);
  mocks.getActiveSessions.mockResolvedValue(new Set<string>());
  mocks.getTerminalExecs.mockResolvedValue(new Set<string>());
  mocks.killExec.mockResolvedValue(undefined);
  mocks.unregisterTerminalExec.mockResolvedValue(undefined);

  await fs.mkdir(path.join(workspaceDir, IDENTITY, "worktrees/saale/c-1a2b3c4d"), {
    recursive: true,
  });
  await fs.mkdir(path.join(workspaceDir, IDENTITY, "projects/saale"), { recursive: true });
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
      force: false,
    });
    expect(mocks.updateWorktree).toHaveBeenCalledWith({
      where: { sessionId: SESSION },
      data: { status: "removed", removedAt: expect.any(Date) },
    });
  });

  it("keeps the chat when git refuses a dirty worktree", async () => {
    mocks.removeWorktree.mockRejectedValue(
      new GitError("fatal: contains modified or untracked files, use --force to delete it", [], {
        stdout: "",
        stderr: "",
        exitCode: 128,
      }),
    );

    const error = await removeChatWorktree(USER, SESSION).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(CoderCleanupError);
    expect((error as CoderCleanupError).message).toContain("modified or untracked");
    // The code is what lets a delete dialog offer "Delete anyway".
    expect((error as CoderCleanupError).code).toBe(WORKTREE_KEPT_CODE);
    expect(mocks.updateWorktree).not.toHaveBeenCalled();
  });

  it("deletes a dirty checkout when the caller forced it", async () => {
    const result = await removeChatWorktree(USER, SESSION, true);

    expect(result).toEqual({ path: "worktrees/saale/c-1a2b3c4d", removed: true });
    expect(mocks.removeWorktree).toHaveBeenCalledWith(USER, {
      repoDir: "projects/saale",
      dir: "worktrees/saale/c-1a2b3c4d",
      force: true,
    });
    expect(mocks.updateWorktree).toHaveBeenCalled();
  });

  it("reports a checkout even a forced deletion could not remove", async () => {
    mocks.removeWorktree.mockRejectedValue(
      new GitError("fatal: could not delete the directory", [], {
        stdout: "",
        stderr: "",
        exitCode: 128,
      }),
    );

    // No code: nothing left to confirm, so the dialog just shows the reason.
    await expect(removeChatWorktree(USER, SESSION, true)).rejects.toThrow(/could not delete/);
    expect(mocks.updateWorktree).not.toHaveBeenCalled();
  });

  it("deletes the files of a checkout whose repo is gone when forced", async () => {
    await fs.rm(path.join(workspaceDir, IDENTITY, "projects"), { recursive: true });

    const result = await removeChatWorktree(USER, SESSION, true);

    expect(result).toEqual({ path: "worktrees/saale/c-1a2b3c4d", removed: true });
    // git has no repo to ask, so the directory goes directly.
    expect(mocks.removeWorktree).not.toHaveBeenCalled();
    expect(mocks.deleteWorktreeDirectory).toHaveBeenCalledWith(USER, "worktrees/saale/c-1a2b3c4d");
    expect(mocks.updateWorktree).toHaveBeenCalled();
  });

  it("drops the chat's branch with its checkout", async () => {
    await removeChatWorktree(USER, SESSION);

    expect(mocks.deleteBranch).toHaveBeenCalledWith(USER, {
      repoDir: "projects/saale",
      branch: "wt/c-1a2b3c4d",
    });
  });

  it("drops the branch of a checkout that is already gone", async () => {
    await fs.rm(path.join(workspaceDir, IDENTITY, "worktrees"), { recursive: true });
    mocks.isBranchPushed.mockResolvedValue(true);

    const result = await removeChatWorktree(USER, SESSION);

    expect(result.removed).toBe(true);
    expect(mocks.removeWorktree).not.toHaveBeenCalled();
    expect(mocks.deleteBranch).toHaveBeenCalledWith(USER, {
      repoDir: "projects/saale",
      branch: "wt/c-1a2b3c4d",
    });
  });

  it("refuses a branch whose commits exist nowhere else", async () => {
    mocks.isBranchPushed.mockResolvedValue(false);

    const error = await removeChatWorktree(USER, SESSION).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(CoderCleanupError);
    expect((error as CoderCleanupError).message).toContain("nowhere else");
    // The same confirmation the dirty-tree refusal asks for.
    expect((error as CoderCleanupError).code).toBe(WORKTREE_KEPT_CODE);
    expect(mocks.removeWorktree).not.toHaveBeenCalled();
    expect(mocks.deleteBranch).not.toHaveBeenCalled();
  });

  it("drops an unpushed branch when the caller forced it", async () => {
    mocks.isBranchPushed.mockResolvedValue(false);

    await removeChatWorktree(USER, SESSION, true);

    expect(mocks.removeWorktree).toHaveBeenCalledWith(
      USER,
      expect.objectContaining({ force: true }),
    );
    expect(mocks.deleteBranch).toHaveBeenCalled();
  });

  it("asks the branch the run left the checkout on", async () => {
    // A review that checked the pull request out holds that branch, not the one
    // the chat was opened on.
    mocks.readStatus.mockResolvedValue({ files: [], branch: "fix-login" });
    mocks.isBranchPushed.mockImplementation(
      async (_user: string, _dir: string, branch: string) => branch !== "fix-login",
    );

    await expect(removeChatWorktree(USER, SESSION)).rejects.toThrow(/fix-login/);
    expect(mocks.isBranchPushed).toHaveBeenCalledWith(USER, "projects/saale", "fix-login");
  });

  it("still drops the chat's own branch when the checkout moved on", async () => {
    mocks.readStatus.mockResolvedValue({ files: [], branch: "" });

    await removeChatWorktree(USER, SESSION);

    expect(mocks.deleteBranch).toHaveBeenCalledWith(USER, {
      repoDir: "projects/saale",
      branch: "wt/c-1a2b3c4d",
    });
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

    expect(mocks.runInWorkspace).toHaveBeenCalledWith(
      USER,
      expect.objectContaining({ cwd: ".", command: expect.stringContaining("pkill -f") }),
    );
    const command = (mocks.runInWorkspace.mock.calls[0]?.[1] as { command: string }).command;
    expect(command).toContain("c-1a2b3c4d");
    // The command-line match misses a server whose cwd is all it shares, so the
    // checkout is swept by working directory too.
    expect(command).toContain('readlink "$p/cwd"');
  });

  it("only forgets the row when the checkout is already gone", async () => {
    await fs.rm(path.join(workspaceDir, IDENTITY, "worktrees"), { recursive: true });

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

  it("refuses when the project row is gone, so the files are not the last copy lost", async () => {
    mocks.findProject.mockResolvedValue(null);
    await expect(removeChatWorktree(USER, SESSION)).rejects.toBeInstanceOf(CoderCleanupError);
  });

  it("refuses when only the repo directory is gone, not the checkout", async () => {
    await fs.rm(path.join(workspaceDir, IDENTITY, "projects"), { recursive: true });

    const error = await removeChatWorktree(USER, SESSION).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(CoderCleanupError);
    expect((error as CoderCleanupError).message).toContain("may be the only copy");
    expect(mocks.removeWorktree).not.toHaveBeenCalled();
    expect(mocks.updateWorktree).not.toHaveBeenCalled();
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

  it("forces every worktree when the project delete was confirmed anyway", async () => {
    mocks.isRepoFullyPushed.mockResolvedValue(true);

    await removeProject(USER, "project-1", true);

    expect(mocks.removeWorktree).toHaveBeenCalledWith(USER, {
      repoDir: "projects/saale",
      dir: "worktrees/saale/c-1a2b3c4d",
      force: true,
    });
    expect(mocks.deleteManyProject).toHaveBeenCalled();
  });

  it("deletes a project whose directory was removed by hand", async () => {
    await fs.rm(path.join(workspaceDir, IDENTITY, "projects"), { recursive: true });
    await fs.rm(path.join(workspaceDir, IDENTITY, "worktrees"), { recursive: true });

    await removeProject(USER, "project-1");

    // Nothing is left on disk to check, so git is never asked about it.
    expect(mocks.isRepoFullyPushed).not.toHaveBeenCalled();
    expect(mocks.deleteChat).toHaveBeenCalledWith(USER, SESSION);
    expect(mocks.deleteManyProject).toHaveBeenCalledWith({
      where: { id: "project-1", userId: USER },
    });
  });

  it("still refuses a project whose directory survived with unpushed work", async () => {
    mocks.isRepoFullyPushed.mockResolvedValue(false);

    await expect(removeProject(USER, "project-1")).rejects.toMatchObject({ status: 409 });
    expect(mocks.deleteManyProject).not.toHaveBeenCalled();
  });

  it("reports a project that is not this user's as missing", async () => {
    mocks.findProject.mockResolvedValue(null);
    await expect(removeProject(USER, "other-project")).rejects.toMatchObject({ status: 404 });
  });
});
