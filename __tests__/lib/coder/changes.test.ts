import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What the right-hand panel reads.
 *
 * The status, the counts and the log come from the same git the model commits
 * with, and a chat whose worktree has not been built is an empty panel rather
 * than a failure.
 */

const mocks = vi.hoisted(() => ({
  findSession: vi.fn(),
  readStatus: vi.fn(),
  readNumstat: vi.fn(),
  readLog: vi.fn(),
  readFileDiff: vi.fn(),
  readWorktreeFile: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: { chatSession: { findFirst: mocks.findSession } },
}));

vi.mock("@/lib/coder/git", () => ({
  readStatus: mocks.readStatus,
  readNumstat: mocks.readNumstat,
  readLog: mocks.readLog,
  readFileDiff: mocks.readFileDiff,
  readWorktreeFile: mocks.readWorktreeFile,
}));

import { assertRepoRelativePath, loadSessionDiff, loadSessionState } from "@/lib/coder/changes";

const USER = "user-1";
const SESSION = "chat-1";

function session(worktree: { status: string } | null) {
  return {
    id: SESSION,
    projectId: "project-1",
    project: { id: "project-1", name: "saale", slug: "saale" },
    coderWorktree: worktree
      ? { path: "worktrees/saale/c-1a2b3c4d", branch: "wt/c-1a2b3c4d", baseSha: "abc", ...worktree }
      : null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findSession.mockResolvedValue(session({ status: "active" }));
  mocks.readStatus.mockResolvedValue({
    branch: "wt/c-1a2b3c4d",
    upstream: "",
    ahead: 0,
    behind: 0,
    head: "abc",
    files: [
      { path: "src/app.ts", originalPath: null, index: "M", worktree: " " },
      { path: "notes.md", originalPath: null, index: " ", worktree: "M" },
      { path: "new.txt", originalPath: null, index: "?", worktree: "?" },
      { path: "renamed.txt", originalPath: "old.txt", index: "R", worktree: " " },
    ],
  });
  mocks.readNumstat.mockResolvedValue([
    { path: "src/app.ts", added: 12, deleted: 3 },
    { path: "notes.md", added: 1, deleted: 0 },
    { path: "renamed.txt", added: 0, deleted: 0, originalPath: "old.txt" },
  ]);
  mocks.readLog.mockResolvedValue([
    { sha: "abc", shortSha: "abc", subject: "add a thing", date: "2026-01-01", author: "Ada" },
  ]);
  mocks.readWorktreeFile.mockResolvedValue(null);
});

describe("loadSessionState", () => {
  it("merges the changed paths with their line counts", async () => {
    const state = await loadSessionState(USER, SESSION);

    expect(state?.branch).toBe("wt/c-1a2b3c4d");
    expect(state?.changes).toEqual([
      {
        path: "src/app.ts",
        originalPath: null,
        added: 12,
        deleted: 3,
        staged: true,
        unstaged: false,
        untracked: false,
      },
      {
        path: "notes.md",
        originalPath: null,
        added: 1,
        deleted: 0,
        staged: false,
        unstaged: true,
        untracked: false,
      },
      {
        path: "new.txt",
        originalPath: null,
        added: null,
        deleted: null,
        staged: false,
        unstaged: false,
        untracked: true,
      },
      {
        path: "renamed.txt",
        originalPath: "old.txt",
        added: 0,
        deleted: 0,
        staged: true,
        unstaged: false,
        untracked: false,
      },
    ]);
    expect(state?.commits).toHaveLength(1);
  });

  it("is an empty panel for a chat whose worktree is not built yet", async () => {
    mocks.findSession.mockResolvedValue(session(null));

    const state = await loadSessionState(USER, SESSION);

    expect(state?.worktree).toBeNull();
    expect(state?.changes).toEqual([]);
    expect(state?.project?.slug).toBe("saale");
    expect(mocks.readStatus).not.toHaveBeenCalled();
  });

  it("is an empty panel for a worktree a cleanup already removed", async () => {
    mocks.findSession.mockResolvedValue(session({ status: "removed" }));
    expect((await loadSessionState(USER, SESSION))?.worktree).toBeNull();
    expect(mocks.readStatus).not.toHaveBeenCalled();
  });

  it("is null for another user's chat, so the route can answer 404", async () => {
    mocks.findSession.mockResolvedValue(null);
    expect(await loadSessionState(USER, SESSION)).toBeNull();
  });
});

describe("loadSessionDiff", () => {
  it("diffs an untracked file against nothing", async () => {
    mocks.readFileDiff.mockResolvedValue("+++ b/new.txt\n+hello\n");

    const diff = await loadSessionDiff(USER, SESSION, { path: "new.txt" });

    expect(diff).toContain("+hello");
    expect(mocks.readFileDiff).toHaveBeenCalledWith(USER, {
      dir: "worktrees/saale/c-1a2b3c4d",
      path: "new.txt",
      staged: false,
      untracked: true,
    });
  });

  it("reads a staged change from the index", async () => {
    mocks.readFileDiff.mockResolvedValue("");

    await loadSessionDiff(USER, SESSION, { path: "src/app.ts", staged: true });

    expect(mocks.readFileDiff).toHaveBeenCalledWith(USER, {
      dir: "worktrees/saale/c-1a2b3c4d",
      path: "src/app.ts",
      staged: true,
      untracked: false,
    });
  });

  it("returns null when the chat has no worktree", async () => {
    mocks.findSession.mockResolvedValue(session(null));
    expect(await loadSessionDiff(USER, SESSION, { path: "a.txt" })).toBeNull();
    expect(mocks.readFileDiff).not.toHaveBeenCalled();
  });
});

describe("assertRepoRelativePath", () => {
  it("accepts a nested path", () => {
    expect(assertRepoRelativePath("src/lib/a.ts")).toBe("src/lib/a.ts");
  });

  it("refuses escapes and absolute paths", () => {
    expect(() => assertRepoRelativePath("../secret")).toThrow();
    expect(() => assertRepoRelativePath("/etc/passwd")).toThrow();
    expect(() => assertRepoRelativePath("src/../../etc")).toThrow();
    expect(() => assertRepoRelativePath("")).toThrow();
    expect(() => assertRepoRelativePath("a//b")).toThrow();
    expect(() => assertRepoRelativePath("a/\0b")).toThrow();
  });
});
