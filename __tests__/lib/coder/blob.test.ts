import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findSession: vi.fn(),
  resolveCommit: vi.fn(),
  blobSizeAt: vi.fn(),
  readBlobBytesAt: vi.fn(),
  readWorkspaceFile: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: { chatSession: { findFirst: mocks.findSession } },
}));

vi.mock("@/lib/coder/git", () => ({
  resolveCommit: mocks.resolveCommit,
  blobSizeAt: mocks.blobSizeAt,
  readBlobBytesAt: mocks.readBlobBytesAt,
}));

vi.mock("@/lib/files/workspace-file", () => ({
  readWorkspaceFile: mocks.readWorkspaceFile,
}));

import { loadSessionBlob } from "@/lib/coder/blob";

const USER = "user-1";
const SESSION = "chat-1";
const WORKTREE = "worktrees/saale/c-1a2b3c4d";
const FULL_SHA = "def45678901234567890123456789012345678901";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findSession.mockResolvedValue({
    id: SESSION,
    projectId: "project-1",
    project: {
      id: "project-1",
      name: "saale",
      slug: "saale",
      repoPath: "projects/saale",
      chatMode: "worktree",
    },
    coderWorktree: { path: WORKTREE, branch: "wt/c-1a2b3c4d", baseSha: "abc", status: "active" },
  });
  mocks.resolveCommit.mockResolvedValue(FULL_SHA);
  mocks.blobSizeAt.mockResolvedValue(1024);
  mocks.readBlobBytesAt.mockResolvedValue(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  mocks.readWorkspaceFile.mockResolvedValue({
    fileName: "probe.png",
    mimeType: "image/png",
    size: 4,
    buffer: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
  });
});

describe("loadSessionBlob", () => {
  it("reads the worktree's copy of a path", async () => {
    const blob = await loadSessionBlob(USER, SESSION, { path: "shots/probe.png" });
    expect(blob).toEqual({
      path: "shots/probe.png",
      mimeType: "image/png",
      buffer: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      immutable: false,
    });
    expect(mocks.readWorkspaceFile).toHaveBeenCalledWith(USER, `${WORKTREE}/shots/probe.png`, {
      maxBytes: 5 * 1024 * 1024,
    });
  });

  it("reads a commit's copy when a sha is given", async () => {
    const blob = await loadSessionBlob(USER, SESSION, { path: "shots/probe.png", sha: "def4567" });
    expect(blob).toMatchObject({ mimeType: "image/png", immutable: true });
    expect(mocks.readBlobBytesAt).toHaveBeenCalledWith(USER, WORKTREE, FULL_SHA, "shots/probe.png");
  });

  it("keeps a PNG's bytes intact", async () => {
    const blob = await loadSessionBlob(USER, SESSION, { path: "shots/probe.png", sha: "def4567" });
    expect(blob && "buffer" in blob ? Array.from(blob.buffer) : null).toEqual([
      0x89, 0x50, 0x4e, 0x47,
    ]);
  });

  it("refuses a sha that is not hex before it reaches git", async () => {
    const blob = await loadSessionBlob(USER, SESSION, { path: "a.png", sha: "../HEAD" });
    expect(blob).toEqual({ error: "Invalid sha", status: 400 });
    expect(mocks.resolveCommit).not.toHaveBeenCalled();
  });

  it("answers a path the commit does not hold", async () => {
    mocks.blobSizeAt.mockResolvedValue(null);
    const blob = await loadSessionBlob(USER, SESSION, { path: "a.png", sha: "def4567" });
    expect(blob).toEqual({ error: "This path is not in the commit", status: 404 });
    expect(mocks.readBlobBytesAt).not.toHaveBeenCalled();
  });

  it("refuses a file past the preview ceiling", async () => {
    mocks.blobSizeAt.mockResolvedValue(6 * 1024 * 1024);
    const blob = await loadSessionBlob(USER, SESSION, { path: "big.png", sha: "def4567" });
    expect(blob).toEqual({ error: "This file is too large to preview", status: 413 });
    expect(mocks.readBlobBytesAt).not.toHaveBeenCalled();
  });

  it("refuses a path that would leave the repo", async () => {
    await expect(loadSessionBlob(USER, SESSION, { path: "../../etc/passwd" })).rejects.toThrow(
      /repo-relative/,
    );
  });

  it("returns nothing for a chat with no checkout", async () => {
    mocks.findSession.mockResolvedValue({
      id: SESSION,
      projectId: "project-1",
      project: null,
      coderWorktree: null,
    });
    expect(await loadSessionBlob(USER, SESSION, { path: "a.png" })).toBeNull();
  });
});
