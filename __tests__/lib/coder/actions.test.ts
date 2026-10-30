import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The git the panel writes.
 *
 * The commands are checked verbatim: a push that forgets `--set-upstream` on a
 * fresh branch fails in the user's face, and a discard that cleans a tracked
 * file deletes work the user did not ask to lose.
 */

const mocks = vi.hoisted(() => ({
  loadCoderSession: vi.fn(),
  runGit: vi.fn(),
  runInWorkspace: vi.fn(),
  readStatus: vi.fn(),
  headSha: vi.fn(),
  resolveSandboxEnv: vi.fn(),
}));

vi.mock("@/lib/coder/changes", () => ({ loadCoderSession: mocks.loadCoderSession }));
vi.mock("@/lib/coder/git", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/coder/git")>();
  return {
    ...actual,
    runGit: mocks.runGit,
    runInWorkspace: mocks.runInWorkspace,
    readStatus: mocks.readStatus,
    headSha: mocks.headSha,
  };
});
vi.mock("@/lib/sandbox/env", () => ({ resolveSandboxEnv: mocks.resolveSandboxEnv }));

import { GitActionNotReadyError, GitActionRefusedError, runGitAction } from "@/lib/coder/actions";

const USER = "user-1";
const SESSION = "chat-1";
const DIR = "worktrees/saale/c-1a2b3c4d";

const OK = { stdout: "", stderr: "", exitCode: 0 };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadCoderSession.mockResolvedValue({
    id: SESSION,
    projectId: "project-1",
    project: { id: "project-1", repoPath: "projects/saale", chatMode: "worktree" },
    coderWorktree: {
      path: DIR,
      branch: "wt/c-1a2b3c4d",
      baseSha: "abc",
      status: "active",
    },
  });
  mocks.runGit.mockResolvedValue(OK);
  mocks.runInWorkspace.mockResolvedValue({ ...OK, stdout: "wt/x" });
  mocks.readStatus.mockResolvedValue({
    branch: "wt/c-1a2b3c4d",
    upstream: "",
    ahead: 0,
    behind: 0,
    head: "abc",
    files: [],
  });
  mocks.headSha.mockResolvedValue("abc");
  mocks.resolveSandboxEnv.mockResolvedValue({});
});

/** The arguments of the last `runGit` call. */
function lastGitArgs(): string[] {
  const call = mocks.runGit.mock.calls.at(-1)?.[1] as { args: string[] } | undefined;
  return call?.args ?? [];
}

describe("push", () => {
  it("sets the upstream when the branch has never been pushed", async () => {
    await runGitAction(USER, SESSION, { action: "push" });

    expect(lastGitArgs()).toEqual(["push", "--set-upstream", "origin", "wt/c-1a2b3c4d"]);
  });

  it("pushes bare once the branch follows a remote", async () => {
    mocks.readStatus.mockResolvedValue({
      branch: "wt/c-1a2b3c4d",
      upstream: "origin/wt/c-1a2b3c4d",
      ahead: 1,
      behind: 0,
      head: "abc",
      files: [],
    });

    await runGitAction(USER, SESSION, { action: "push" });

    expect(lastGitArgs()).toEqual(["push"]);
  });

  it("logs in with GH_TOKEN and never writes it to a file", async () => {
    mocks.resolveSandboxEnv.mockResolvedValue({ GH_TOKEN: "ghp_secret" });

    await runGitAction(USER, SESSION, { action: "push" });

    const [userId, options] = mocks.runGit.mock.calls.at(-1) as [
      string,
      { args: string[]; env: Record<string, string> },
    ];
    expect(userId).toBe(USER);
    expect(options.args[0]).toBe("-c");
    expect(options.args[1]).toContain("credential.helper=");
    expect(options.args[1]).toContain("$GH_TOKEN");
    expect(options.args[1]).not.toContain("ghp_secret");
    expect(options.env).toEqual({ GH_TOKEN: "ghp_secret" });
  });

  it("leaves git's own credentials alone when the user has no token", async () => {
    await runGitAction(USER, SESSION, { action: "push" });

    const [, options] = mocks.runGit.mock.calls.at(-1) as [
      string,
      { args: string[]; env: Record<string, string> },
    ];
    expect(options.args[0]).toBe("push");
    expect(options.env).toEqual({});
  });
});

describe("pull", () => {
  it("refuses a branch with no upstream instead of merging something", async () => {
    await expect(runGitAction(USER, SESSION, { action: "pull", rebase: false })).rejects.toThrow(
      GitActionRefusedError,
    );
    expect(mocks.runGit).not.toHaveBeenCalled();
  });

  it("fast-forwards by default and rebases when asked", async () => {
    mocks.readStatus.mockResolvedValue({
      branch: "wt/c-1a2b3c4d",
      upstream: "origin/main",
      ahead: 0,
      behind: 2,
      head: "abc",
      files: [],
    });

    await runGitAction(USER, SESSION, { action: "pull", rebase: false });
    expect(lastGitArgs()).toEqual(["pull", "--ff-only"]);

    await runGitAction(USER, SESSION, { action: "pull", rebase: true });
    expect(lastGitArgs()).toEqual(["pull", "--rebase"]);
  });
});

describe("commit", () => {
  it("refuses an empty message before git runs", async () => {
    await expect(
      runGitAction(USER, SESSION, { action: "commit", message: "   ", amend: false, push: false }),
    ).rejects.toThrow("Write a commit message first.");
    expect(mocks.runGit).not.toHaveBeenCalled();
  });

  it("passes the message as one argument and amends on request", async () => {
    await runGitAction(USER, SESSION, {
      action: "commit",
      message: "  fix the panel \n",
      amend: true,
      push: false,
    });

    expect(lastGitArgs()).toEqual(["commit", "--message", "fix the panel", "--amend"]);
  });

  it("pushes after the commit when that is what the button said", async () => {
    await runGitAction(USER, SESSION, {
      action: "commit",
      message: "one change",
      amend: false,
      push: true,
    });

    const commands = mocks.runGit.mock.calls.map((call) => (call[1] as { args: string[] }).args[0]);
    expect(commands).toEqual(["commit", "push"]);
  });
});

describe("stage and unstage", () => {
  it("stages everything with no paths and one file with a path", async () => {
    await runGitAction(USER, SESSION, { action: "stage", paths: [] });
    expect(lastGitArgs()).toEqual(["add", "--all"]);

    await runGitAction(USER, SESSION, { action: "stage", paths: ["src/app.ts"] });
    expect(lastGitArgs()).toEqual(["add", "--", "src/app.ts"]);
  });

  it("unstages through the index, and drops the entry when there is no HEAD", async () => {
    await runGitAction(USER, SESSION, { action: "unstage", paths: ["src/app.ts"] });
    expect(lastGitArgs()).toEqual(["reset", "--quiet", "--", "src/app.ts"]);

    mocks.headSha.mockResolvedValue("");
    await runGitAction(USER, SESSION, { action: "unstage", paths: [] });
    expect(lastGitArgs()).toContain("--cached");
  });
});

describe("discard", () => {
  it("cleans an untracked path and restores a tracked one", async () => {
    mocks.readStatus.mockResolvedValue({
      branch: "wt/c-1a2b3c4d",
      upstream: "",
      ahead: 0,
      behind: 0,
      head: "abc",
      files: [
        { path: "new.txt", originalPath: null, index: "?", worktree: "?" },
        { path: "src/app.ts", originalPath: null, index: " ", worktree: "M" },
      ],
    });

    await runGitAction(USER, SESSION, { action: "discard", paths: ["new.txt", "src/app.ts"] });

    const commands = mocks.runGit.mock.calls.map((call) => (call[1] as { args: string[] }).args);
    expect(commands).toEqual([
      ["restore", "--source=HEAD", "--staged", "--worktree", "--", "src/app.ts"],
      ["clean", "--force", "--", "new.txt"],
    ]);
  });

  it("refuses to discard before the branch has a commit to restore to", async () => {
    mocks.headSha.mockResolvedValue("");

    await expect(
      runGitAction(USER, SESSION, { action: "discard", paths: ["src/app.ts"] }),
    ).rejects.toThrow(GitActionRefusedError);
  });
});

describe("branches", () => {
  it("asks git whether the name is legal, then switches", async () => {
    await runGitAction(USER, SESSION, { action: "branch", name: "feat/x", create: true });

    expect(mocks.runInWorkspace).toHaveBeenCalledWith(
      USER,
      expect.objectContaining({ command: expect.stringContaining("check-ref-format --branch") }),
    );
    expect(lastGitArgs()).toEqual(["switch", "--create", "feat/x"]);
  });

  it("refuses a name git does not accept", async () => {
    mocks.runInWorkspace.mockResolvedValue({ stdout: "", stderr: "fatal", exitCode: 128 });

    await expect(
      runGitAction(USER, SESSION, { action: "branch", name: "not a branch", create: false }),
    ).rejects.toThrow("Not a branch name: not a branch");
    expect(mocks.runGit).not.toHaveBeenCalled();
  });

  it("refuses a name that would be read as a flag", async () => {
    await expect(
      runGitAction(USER, SESSION, { action: "branch", name: "-D", create: false }),
    ).rejects.toThrow(GitActionRefusedError);
  });
});

describe("stash", () => {
  it("says nothing was stashed rather than reporting success on a clean tree", async () => {
    mocks.runGit.mockResolvedValue({
      stdout: "No local changes to save\n",
      stderr: "",
      exitCode: 0,
    });

    await expect(runGitAction(USER, SESSION, { action: "stash" })).rejects.toThrow(
      "Nothing to stash: the worktree is clean.",
    );
  });
});

describe("the chat a request names", () => {
  it("is null for someone else's chat, so the route can answer 404", async () => {
    mocks.loadCoderSession.mockResolvedValue(null);

    await expect(runGitAction(USER, "chat-other", { action: "fetch" })).resolves.toBeNull();
    expect(mocks.runGit).not.toHaveBeenCalled();
  });

  it("has no checkout until the first message builds one", async () => {
    mocks.loadCoderSession.mockResolvedValue({
      id: SESSION,
      projectId: "project-1",
      project: { id: "project-1", repoPath: "projects/saale", chatMode: "worktree" },
      coderWorktree: null,
    });

    await expect(runGitAction(USER, SESSION, { action: "fetch" })).rejects.toThrow(
      GitActionNotReadyError,
    );
  });
});

describe("one writer at a time", () => {
  it("runs two actions on the same repo in order, never beside each other", async () => {
    const order: string[] = [];
    mocks.runGit.mockImplementation(async () => {
      order.push("start");
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push("end");
      return OK;
    });

    await Promise.all([
      runGitAction(USER, SESSION, { action: "fetch" }),
      runGitAction(USER, SESSION, { action: "fetch" }),
    ]);

    expect(order).toEqual(["start", "end", "start", "end"]);
  });
});
