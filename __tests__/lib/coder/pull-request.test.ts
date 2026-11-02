import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  parsePullRequest,
  refreshStalePullRequests,
  syncPullRequest,
} from "@/lib/coder/pull-request";

/**
 * What `gh pr view --json` answers, and what the app does with it.
 *
 * The badge on the branch is the only thing that says a pull request exists, so
 * a shape gh changes, or a check kind it adds, must not take the badge down.
 * What the forge answered is also what the coder landing page reads, which is
 * why the answer is written down and refreshed only while it can still move.
 */

const mocks = vi.hoisted(() => ({
  updateMany: vi.fn(),
  runInWorkspace: vi.fn(),
  loadCoderSession: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ prisma: { chatSession: { updateMany: mocks.updateMany } } }));
vi.mock("@/lib/coder/git", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/coder/git")>()),
  runInWorkspace: mocks.runInWorkspace,
}));
vi.mock("@/lib/coder/changes", () => ({ loadCoderSession: mocks.loadCoderSession }));
vi.mock("@/lib/sandbox/env", () => ({ resolveSandboxEnv: vi.fn(async () => ({})) }));

const OPEN_PR = {
  number: 42,
  title: "Add the git actions",
  state: "OPEN",
  url: "https://github.com/acme/saale/pull/42",
  isDraft: false,
  reviewDecision: "APPROVED",
  statusCheckRollup: [
    { __typename: "CheckRun", conclusion: "SUCCESS", status: "COMPLETED" },
    { __typename: "CheckRun", conclusion: "FAILURE", status: "COMPLETED" },
    { __typename: "CheckRun", conclusion: null, status: "IN_PROGRESS" },
    { __typename: "StatusContext", state: "SUCCESS" },
  ],
};

describe("parsePullRequest", () => {
  it("reads the badge's numbers, its state and its checks", () => {
    const parsed = parsePullRequest(JSON.stringify(OPEN_PR));

    expect(parsed).toMatchObject({
      number: 42,
      state: "OPEN",
      draft: false,
      reviewDecision: "APPROVED",
      url: "https://github.com/acme/saale/pull/42",
    });
    expect(parsed?.checks).toEqual({ passed: 2, failed: 1, pending: 1 });
  });

  it("has no check counts when the pull request ran none", () => {
    const parsed = parsePullRequest(JSON.stringify({ ...OPEN_PR, statusCheckRollup: [] }));
    expect(parsed?.checks).toBeNull();
  });

  it("reads a draft", () => {
    expect(parsePullRequest(JSON.stringify({ ...OPEN_PR, isDraft: true }))?.draft).toBe(true);
  });

  it("is null when gh printed something that is not a pull request", () => {
    expect(parsePullRequest("")).toBeNull();
    expect(parsePullRequest("no pull requests found for branch")).toBeNull();
    expect(parsePullRequest(JSON.stringify({ state: "OPEN" }))).toBeNull();
  });
});

describe("syncPullRequest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.updateMany.mockResolvedValue({ count: 1 });
    mocks.loadCoderSession.mockResolvedValue({
      id: "c1",
      coderWorktree: {
        path: "worktrees/one/c1",
        branch: "wt/c1",
        baseSha: "abc",
        status: "active",
      },
      project: null,
    });
  });

  it("writes what the forge answered onto the chat row", async () => {
    mocks.runInWorkspace.mockResolvedValue({
      stdout: JSON.stringify(OPEN_PR),
      stderr: "",
      exitCode: 0,
    });

    const pullRequest = await syncPullRequest("u1", "c1");

    expect(pullRequest).toMatchObject({ number: 42, state: "OPEN" });
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { id: "c1", userId: "u1" },
      data: expect.objectContaining({
        prNumber: 42,
        prState: "OPEN",
        prDraft: false,
        prUrl: "https://github.com/acme/saale/pull/42",
      }),
    });
  });

  it("clears the row when the branch has no pull request any more", async () => {
    mocks.runInWorkspace.mockResolvedValue({
      stdout: "",
      stderr: "no pull requests found for branch wt/c1",
      exitCode: 1,
    });

    expect(await syncPullRequest("u1", "c1")).toBeNull();
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { id: "c1", userId: "u1" },
      data: expect.objectContaining({ prNumber: null, prState: null }),
    });
  });

  it("writes down that it asked, and keeps what it knew, when nobody answered", async () => {
    mocks.runInWorkspace.mockResolvedValue({
      stdout: "",
      stderr: "dial tcp: lookup api.github.com: no such host",
      exitCode: 1,
    });

    expect(await syncPullRequest("u1", "c1")).toBeNull();
    // Only the timestamp: a forge that is down must not take a badge down.
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { id: "c1", userId: "u1" },
      data: { prCheckedAt: expect.any(Date) },
    });
  });
});

describe("refreshStalePullRequests", () => {
  const longAgo = new Date(Date.now() - 60 * 60_000).toISOString();
  const justNow = new Date().toISOString();

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.updateMany.mockResolvedValue({ count: 1 });
    mocks.loadCoderSession.mockResolvedValue({
      id: "c1",
      coderWorktree: {
        path: "worktrees/one/c1",
        branch: "wt/c1",
        baseSha: "abc",
        status: "active",
      },
      project: null,
    });
    mocks.runInWorkspace.mockResolvedValue({
      stdout: JSON.stringify(OPEN_PR),
      stderr: "",
      exitCode: 0,
    });
  });

  it("asks again about an open pull request the list is about to show stale", async () => {
    await refreshStalePullRequests("u1", [
      { id: "c1", pullRequest: { state: "OPEN" }, pullRequestCheckedAt: new Date(longAgo) },
    ]);

    expect(mocks.runInWorkspace).toHaveBeenCalledTimes(1);
    expect(mocks.updateMany).toHaveBeenCalledTimes(1);
  });

  it("asks about a chat nobody has asked about yet", async () => {
    await refreshStalePullRequests("u1", [
      { id: "c1", pullRequest: null, pullRequestCheckedAt: null },
    ]);

    expect(mocks.runInWorkspace).toHaveBeenCalledTimes(1);
  });

  it("leaves alone what cannot change or was just answered", async () => {
    await refreshStalePullRequests("u1", [
      { id: "c1", pullRequest: { state: "MERGED" }, pullRequestCheckedAt: new Date(longAgo) },
      { id: "c2", pullRequest: { state: "OPEN" }, pullRequestCheckedAt: new Date(justNow) },
      // Asked, and the branch had no pull request.
      { id: "c3", pullRequest: null, pullRequestCheckedAt: new Date(longAgo) },
    ]);

    expect(mocks.runInWorkspace).not.toHaveBeenCalled();
  });
});
