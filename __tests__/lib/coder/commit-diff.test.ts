import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findSession: vi.fn(),
  readCommitDiff: vi.fn(),
  readBlobAt: vi.fn(),
  resolveCommit: vi.fn(),
  blobSizeAt: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: { chatSession: { findFirst: mocks.findSession } },
}));

vi.mock("@/lib/coder/git", () => ({
  readCommitDiff: mocks.readCommitDiff,
  readBlobAt: mocks.readBlobAt,
  resolveCommit: mocks.resolveCommit,
  blobSizeAt: mocks.blobSizeAt,
}));

import { loadCommitDiff, loadCommitDiffFile } from "@/lib/coder/commit-diff";

const USER = "user-1";
const SESSION = "chat-1";
const WORKTREE = "worktrees/saale/c-1a2b3c4d";

function activeSession() {
  return {
    id: SESSION,
    projectId: "project-1",
    project: { id: "project-1", name: "saale", slug: "saale" },
    coderWorktree: {
      path: WORKTREE,
      branch: "wt/c-1a2b3c4d",
      baseSha: "abc",
      status: "active",
    },
  };
}

function diffFile(overrides: Record<string, unknown> = {}) {
  return {
    path: "src/app.ts",
    originalPath: null,
    status: "M",
    added: 2,
    deleted: 1,
    baseRef: "def",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findSession.mockResolvedValue(activeSession());
  mocks.resolveCommit.mockResolvedValue("def45678901234567890123456789012345678901");
  mocks.readCommitDiff.mockResolvedValue([diffFile()]);
  mocks.blobSizeAt.mockResolvedValue(10);
  mocks.readBlobAt.mockResolvedValue("text");
});

describe("loadCommitDiff", () => {
  it("lists the commit's files", async () => {
    const files = await loadCommitDiff(USER, SESSION, "def4567");
    expect(files).toEqual([diffFile()]);
    expect(mocks.readCommitDiff).toHaveBeenCalledWith(
      USER,
      WORKTREE,
      "def45678901234567890123456789012345678901",
    );
  });

  it("returns nothing for a sha that is not hex", async () => {
    expect(await loadCommitDiff(USER, SESSION, "not-a-sha")).toBeNull();
    expect(mocks.resolveCommit).not.toHaveBeenCalled();
  });

  it("returns nothing for a commit the repo does not have", async () => {
    mocks.resolveCommit.mockResolvedValue(null);
    expect(await loadCommitDiff(USER, SESSION, "deadbee")).toBeNull();
    expect(mocks.readCommitDiff).not.toHaveBeenCalled();
  });

  it("returns nothing for a chat whose worktree is gone", async () => {
    mocks.findSession.mockResolvedValue({ ...activeSession(), coderWorktree: null });
    expect(await loadCommitDiff(USER, SESSION, "deadbee")).toBeNull();
  });
});

describe("loadCommitDiffFile", () => {
  it("returns nothing for a sha that is not hex", async () => {
    expect(await loadCommitDiffFile(USER, SESSION, "def", "src/app.ts")).toBeNull();
    expect(mocks.resolveCommit).not.toHaveBeenCalled();
  });

  it("reads both sides from the commit and its parent", async () => {
    const result = await loadCommitDiffFile(USER, SESSION, "def4567", "src/app.ts");
    expect(result).toEqual({
      path: "src/app.ts",
      binary: false,
      original: "text",
      modified: "text",
    });
    expect(mocks.readBlobAt).toHaveBeenCalledWith(USER, WORKTREE, "def", "src/app.ts");
    expect(mocks.readBlobAt).toHaveBeenCalledWith(
      USER,
      WORKTREE,
      "def45678901234567890123456789012345678901",
      "src/app.ts",
    );
  });

  it("refuses a path the commit never touched", async () => {
    const result = await loadCommitDiffFile(USER, SESSION, "def4567", "src/other.ts");
    expect(result).toEqual({ error: "Path is not part of this commit", status: 404 });
    expect(mocks.readBlobAt).not.toHaveBeenCalled();
  });

  it("refuses a path that would leave the repo", async () => {
    const result = await loadCommitDiffFile(USER, SESSION, "def4567", "../outside.txt");
    expect(result).toEqual({ error: "Invalid path", status: 400 });
  });

  it("marks a binary path instead of reading it", async () => {
    mocks.readCommitDiff.mockResolvedValue([diffFile({ status: "A", added: null, deleted: null })]);
    const result = await loadCommitDiffFile(USER, SESSION, "def4567", "src/app.ts");
    expect(result).toEqual({ path: "src/app.ts", binary: true, original: null, modified: null });
    expect(mocks.readBlobAt).not.toHaveBeenCalled();
  });

  it("marks a side over the size cap instead of reading it", async () => {
    mocks.blobSizeAt.mockResolvedValueOnce(10).mockResolvedValueOnce(2 * 1024 * 1024);
    const result = await loadCommitDiffFile(USER, SESSION, "def4567", "src/app.ts");
    expect(result).toMatchObject({ binary: true });
    expect(mocks.readBlobAt).not.toHaveBeenCalled();
  });

  it("reads a deleted file's original side only", async () => {
    mocks.readCommitDiff.mockResolvedValue([diffFile({ status: "D" })]);
    const result = await loadCommitDiffFile(USER, SESSION, "def4567", "src/app.ts");
    expect(result).toEqual({ path: "src/app.ts", binary: false, original: "text", modified: "" });
    expect(mocks.readBlobAt).toHaveBeenCalledTimes(1);
    expect(mocks.readBlobAt).toHaveBeenCalledWith(USER, WORKTREE, "def", "src/app.ts");
  });

  it("reads a root commit's files against the empty original side", async () => {
    mocks.readCommitDiff.mockResolvedValue([diffFile({ status: "A", baseRef: null })]);
    const result = await loadCommitDiffFile(USER, SESSION, "def4567", "src/app.ts");
    expect(result).toEqual({ path: "src/app.ts", binary: false, original: "", modified: "text" });
    expect(mocks.blobSizeAt).toHaveBeenCalledTimes(1);
  });
});
