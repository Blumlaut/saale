import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPullRequest,
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
  // The real module answers `{}` when nothing is configured; the mock must too,
  // or the code under test trips over an undefined env.
  commandEnv: vi.fn(async () => ({})),
  userEnv: vi.fn(async () => ({})),
}));

vi.mock("@/lib/db", () => ({ prisma: { chatSession: { updateMany: mocks.updateMany } } }));
vi.mock("@/lib/coder/git", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/coder/git")>()),
  runInWorkspace: mocks.runInWorkspace,
}));
vi.mock("@/lib/coder/changes", () => ({ loadCoderSession: mocks.loadCoderSession }));
vi.mock("@/lib/sandbox/env", () => ({ resolveSandboxEnv: vi.fn(async () => ({})) }));
vi.mock("@/lib/integrations/github-credentials", () => ({
  resolveGithubCommandEnv: mocks.commandEnv,
  resolveGithubUserEnv: mocks.userEnv,
}));

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

/**
 * Who a pull request belongs to.
 *
 * The chat pushes with the narrow installation token, which authenticates the
 * app: a pull request it opens is authored by the app's bot, with the person's
 * name only as a footnote. Opening it is a single call whose author GitHub
 * records, so it has to carry the connected account's own token instead.
 */
describe("createPullRequest", () => {
  const CREATED = "https://github.com/acme/saale/pull/42";

  beforeEach(() => {
    vi.resetAllMocks();
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
    mocks.commandEnv.mockResolvedValue({ GH_TOKEN: "installation-token" });
    mocks.userEnv.mockResolvedValue({ GH_TOKEN: "personal-token" });
  });

  it("opens it with the connected account's token, not the installation's", async () => {
    mocks.runInWorkspace
      .mockResolvedValueOnce({ stdout: `${CREATED}\n`, stderr: "", exitCode: 0 })
      .mockResolvedValueOnce({ stdout: JSON.stringify(OPEN_PR), stderr: "", exitCode: 0 });

    await createPullRequest("u1", "c1", { draft: false });

    const create = mocks.runInWorkspace.mock.calls[0]?.[1] as { env: Record<string, string> };
    expect(create.env.GH_TOKEN).toBe("personal-token");
  });

  it("keeps what the workspace granted when no authorization answers", async () => {
    mocks.userEnv.mockResolvedValue({});
    mocks.runInWorkspace
      .mockResolvedValueOnce({ stdout: `${CREATED}\n`, stderr: "", exitCode: 0 })
      .mockResolvedValueOnce({ stdout: JSON.stringify(OPEN_PR), stderr: "", exitCode: 0 });

    await createPullRequest("u1", "c1", { draft: false });

    const create = mocks.runInWorkspace.mock.calls[0]?.[1] as { env: Record<string, string> };
    expect(create.env.GH_TOKEN).toBe("installation-token");
  });

  it("says what gh said when the pull request could not be opened", async () => {
    mocks.runInWorkspace.mockResolvedValueOnce({
      stdout: "",
      stderr: "a pull request for branch wt/c1 already exists",
      exitCode: 1,
    });

    await expect(createPullRequest("u1", "c1", { draft: false })).rejects.toThrow("already exists");
  });
});
