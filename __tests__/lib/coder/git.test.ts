import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

type GitExecResult = { stdout: string; stderr: string; exitCode: number };

const execOptions: Array<Record<string, unknown>> = [];
let execResult: GitExecResult = { stdout: "", stderr: "", exitCode: 0 };
/** One result per command, for a test whose commands differ. */
let execQueue: GitExecResult[] | null = null;

vi.mock("@/lib/sandbox/client", () => ({
  exec: async function* (options: Record<string, unknown>) {
    execOptions.push(options);
    const result = execQueue?.shift() ?? execResult;
    yield { type: "chunk", stream: "stdout", data: Buffer.from(result.stdout) };
    yield { type: "chunk", stream: "stderr", data: Buffer.from(result.stderr) };
    yield { type: "exit", exitCode: result.exitCode, timedOut: false, durationMs: 1 };
  },
}));

let sandboxEnv: Record<string, string> = { GH_TOKEN: "secret-token" };

vi.mock("@/lib/sandbox/env", () => ({
  resolveSandboxEnv: async () => sandboxEnv,
}));

import {
  EMPTY_TREE,
  GitError,
  addWorktree,
  addWorktreeOnBranch,
  cloneRepo,
  fetchOrigin,
  isRepoFullyPushed,
  readCommitDiff,
  refSha,
  removeWorktree,
  resolveCommit,
  runGit,
  shellQuote,
  worktreeBaseRef,
} from "@/lib/coder/git";
import { userIdentity } from "@/lib/sandbox/identity";
import { sandboxConfig } from "@/lib/sandbox/config";

const USER = "user-1";
const IDENTITY = userIdentity(USER);
/** The user's workspace as the app path it is mounted at. */
const USER_ROOT = `${sandboxConfig().workspacesDir}/${IDENTITY}`;

beforeEach(() => {
  execOptions.length = 0;
  execResult = { stdout: "", stderr: "", exitCode: 0 };
  execQueue = null;
  sandboxEnv = { GH_TOKEN: "secret-token" };
});

describe("shellQuote", () => {
  it("leaves a plain argument alone and quotes the rest", () => {
    expect(shellQuote("status")).toBe("status");
    expect(shellQuote("origin/main")).toBe("origin/main");
    expect(shellQuote("a b")).toBe("'a b'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
    expect(shellQuote("$(rm -rf /)")).toBe("'$(rm -rf /)'");
  });
});

describe("runGit", () => {
  it("runs git without a pager in the resolved directory", async () => {
    await runGit(USER, { cwd: "projects/saale", args: ["status", "--porcelain=v1", "-z"] });

    const options = execOptions[0] as { command: string; cwd: string; env: Record<string, string> };
    expect(options.command).toBe("git --no-pager status --porcelain=v1 -z");
    expect(options.cwd).toBe(`${USER_ROOT}/projects/saale`);
    expect(options.env.GIT_TERMINAL_PROMPT).toBe("0");
  });

  it("refuses a directory outside the workspace before running anything", async () => {
    await expect(runGit(USER, { cwd: "../other-user", args: ["status"] })).rejects.toThrow();
    expect(execOptions).toHaveLength(0);
  });

  it("throws git's own message on a non-zero exit", async () => {
    execResult = { stdout: "", stderr: "fatal: not a git repository\n", exitCode: 128 };
    await expect(runGit(USER, { cwd: "projects/saale", args: ["status"] })).rejects.toThrow(
      /not a git repository/,
    );
  });

  it("returns the result when a failure is expected", async () => {
    execResult = { stdout: "some diff\n", stderr: "", exitCode: 1 };
    const result = await runGit(USER, {
      cwd: "worktrees/saale/c-1",
      args: ["diff", "--no-index", "--", "/dev/null", "new.txt"],
      allowFailure: true,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("some diff\n");
  });

  it("keeps the failure class for callers that branch on it", async () => {
    execResult = { stdout: "", stderr: "error: working tree is dirty\n", exitCode: 1 };
    const error = await runGit(USER, {
      cwd: "projects/saale",
      args: ["worktree", "remove", "worktrees/saale/c-1"],
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(GitError);
    expect((error as GitError).result.stderr).toContain("working tree is dirty");
  });
});

describe("worktrees", () => {
  const root = USER_ROOT;

  it("adds a new branch at an absolute path inside the workspace", async () => {
    await addWorktree(USER, {
      repoDir: "projects/saale",
      dir: "worktrees/saale/c-1",
      branch: "wt/c-1",
      base: "main",
    });

    const options = execOptions[0] as { command: string; cwd: string };
    // git resolves the path against its cwd, which is the repo, so a relative
    // path would check out inside it.
    expect(options.command).toBe(
      `git --no-pager worktree add -b wt/c-1 ${root}/worktrees/saale/c-1 main`,
    );
    expect(options.cwd).toBe(`${root}/projects/saale`);
  });

  it("checks out an existing branch at the same absolute path", async () => {
    await addWorktreeOnBranch(USER, {
      repoDir: "projects/saale",
      dir: "worktrees/saale/c-1",
      branch: "wt/c-1",
    });

    const options = execOptions[0] as { command: string };
    expect(options.command).toBe(`git --no-pager worktree add ${root}/worktrees/saale/c-1 wt/c-1`);
  });

  it("removes the checkout at its absolute path", async () => {
    await removeWorktree(USER, { repoDir: "projects/saale", dir: "worktrees/saale/c-1" });

    const options = execOptions[0] as { command: string };
    expect(options.command).toBe(`git --no-pager worktree remove ${root}/worktrees/saale/c-1`);
  });

  it("discards the checkout's changes when forced", async () => {
    await removeWorktree(USER, {
      repoDir: "projects/saale",
      dir: "worktrees/saale/c-1",
      force: true,
    });

    const options = execOptions[0] as { command: string };
    expect(options.command).toBe(
      `git --no-pager worktree remove --force --force ${root}/worktrees/saale/c-1`,
    );
  });

  it("deletes the directory when git still refuses a forced removal", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    execQueue = [
      { stdout: "", stderr: "fatal: contains submodule at 'vendor'\n", exitCode: 128 },
      { stdout: "", stderr: "", exitCode: 0 },
      { stdout: "", stderr: "", exitCode: 0 },
    ];

    await removeWorktree(USER, {
      repoDir: "projects/saale",
      dir: "worktrees/saale/c-1",
      force: true,
    });

    const commands = execOptions.map((options) => (options as { command: string }).command);
    expect(commands).toEqual([
      `git --no-pager worktree remove --force --force ${root}/worktrees/saale/c-1`,
      `rm -rf -- ${root}/worktrees/saale/c-1`,
      "git --no-pager worktree prune",
    ]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("cloneRepo", () => {
  it("clones with plain git when the user has no token", async () => {
    sandboxEnv = {};
    await cloneRepo(USER, { dir: "projects/saale", url: "https://github.com/Blumlaut/saale.git" });
    const options = execOptions[0] as { command: string; env?: Record<string, string> };
    expect(options.command).toBe(
      "git clone -- https://github.com/Blumlaut/saale.git projects/saale",
    );
    expect(options.env?.GH_TOKEN).toBeUndefined();
  });

  it("clones through gh on its own when the token is configured", async () => {
    await cloneRepo(USER, {
      dir: "projects/private",
      url: "https://github.com/Blumlaut/private.git",
    });
    const options = execOptions[0] as { command: string; env: Record<string, string> };
    expect(options.command).toBe(
      "gh repo clone https://github.com/Blumlaut/private.git projects/private",
    );
    expect(options.env.GH_TOKEN).toBe("secret-token");
  });

  it("reports git's message when the clone fails", async () => {
    execResult = {
      stdout: "",
      stderr: "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
      exitCode: 128,
    };
    await expect(
      cloneRepo(USER, { dir: "projects/private", url: "https://github.com/Blumlaut/x.git" }),
    ).rejects.toThrow(/terminal prompts disabled/);
  });
});

describe("ensureGitconfig", () => {
  let dir: string;
  const originalDir = process.env.SANDBOX_WORKSPACES_DIR;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "saale-gitconfig-"));
    process.env.SANDBOX_WORKSPACES_DIR = dir;
  });

  afterEach(async () => {
    process.env.SANDBOX_WORKSPACES_DIR = originalDir;
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("writes the identity and the rules git needs inside the container", async () => {
    const { ensureGitconfig, gitIdentityFor } = await import("@/lib/coder/gitconfig");
    const identity = gitIdentityFor({ name: " Ada ", email: "ada@example.com" });
    const target = await ensureGitconfig(USER, identity);

    const body = await fs.readFile(target, "utf8");
    expect(target).toBe(path.join(dir, IDENTITY, ".gitconfig"));
    expect(body).toContain("name = Ada");
    expect(body).toContain("email = ada@example.com");
    expect(body).toContain("defaultBranch = main");
    expect(body).toContain("ff = only");
    expect(body).toContain(`directory = ${path.join(dir, IDENTITY)}`);
  });

  it("leaves a config that already matches alone", async () => {
    const { ensureGitconfig, gitIdentityFor } = await import("@/lib/coder/gitconfig");
    const identity = gitIdentityFor({ name: "Ada", email: "ada@example.com" });
    const first = await ensureGitconfig(USER, identity);
    const before = await fs.stat(first);

    await ensureGitconfig(USER, identity);
    const after = await fs.stat(first);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it("rewrites the config when the identity changes", async () => {
    const { ensureGitconfig, gitIdentityFor } = await import("@/lib/coder/gitconfig");
    await ensureGitconfig(USER, gitIdentityFor({ name: "Ada", email: "ada@example.com" }));
    const target = await ensureGitconfig(
      USER,
      gitIdentityFor({ name: "Grace", email: "grace@example.com" }),
    );
    expect(await fs.readFile(target, "utf8")).toContain("name = Grace");
  });

  it("keeps a credential helper the user set up", async () => {
    const { ensureGitconfig, gitIdentityFor } = await import("@/lib/coder/gitconfig");
    const identity = gitIdentityFor({ name: "Ada", email: "ada@example.com" });
    const target = await ensureGitconfig(USER, identity);
    const withHelper = `${await fs.readFile(target, "utf8")}[credential]\n\thelper = store\n`;
    await fs.writeFile(target, withHelper, "utf8");

    await ensureGitconfig(USER, identity);

    const body = await fs.readFile(target, "utf8");
    expect(body).toBe(withHelper);
    expect(body).toContain("helper = store");
  });

  it("leaves gh's own credential setup byte for byte", async () => {
    const { ensureGitconfig, gitIdentityFor } = await import("@/lib/coder/gitconfig");
    const identity = gitIdentityFor({ name: "Ada", email: "ada@example.com" });
    const target = await ensureGitconfig(USER, identity);
    // What `gh auth setup-git` appends, trailing space and all.
    const ghBlock = [
      '[credential "https://github.com"]',
      "\thelper = ",
      "\thelper = !/usr/bin/gh auth git-credential",
      '[credential "https://gist.github.com"]',
      "\thelper = ",
      "\thelper = !/usr/bin/gh auth git-credential",
      "",
    ].join("\n");
    const file = `${await fs.readFile(target, "utf8")}${ghBlock}`;
    await fs.writeFile(target, file, "utf8");
    const before = await fs.stat(target);

    await ensureGitconfig(USER, identity);

    const after = await fs.stat(target);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(await fs.readFile(target, "utf8")).toBe(file);
  });

  it("keeps a config of the user's own and adds only what it needs", async () => {
    const { ensureGitconfig, gitIdentityFor } = await import("@/lib/coder/gitconfig");
    const identity = gitIdentityFor({ name: "Ada", email: "ada@example.com" });
    const root = path.join(dir, IDENTITY);
    await fs.mkdir(root, { recursive: true });
    const target = path.join(root, ".gitconfig");
    const theirs = [
      '[credential "https://github.com"]',
      "\thelper = !gh auth git-credential",
      "[commit]",
      "\tgpgsign = true",
      "",
    ].join("\n");
    await fs.writeFile(target, theirs, "utf8");

    await ensureGitconfig(USER, identity);

    const body = await fs.readFile(target, "utf8");
    expect(body.startsWith(theirs)).toBe(true);
    expect(body).toContain("helper = !gh auth git-credential");
    expect(body).toContain("gpgsign = true");
    expect(body).toContain("name = Ada");
    expect(body).toContain(`directory = ${root}`);
  });

  it("corrects a setting a hand edit changed and keeps the rest", async () => {
    const { ensureGitconfig, gitIdentityFor } = await import("@/lib/coder/gitconfig");
    const identity = gitIdentityFor({ name: "Ada", email: "ada@example.com" });
    const target = await ensureGitconfig(USER, identity);
    const edited = (await fs.readFile(target, "utf8"))
      .replace("name = Ada", "name = Someone Else")
      .concat('[credential "https://gitea.local"]\n\thelper = store\n');
    await fs.writeFile(target, edited, "utf8");

    await ensureGitconfig(USER, identity);

    const body = await fs.readFile(target, "utf8");
    expect(body).toContain("name = Ada");
    expect(body).not.toContain("Someone Else");
    expect(body).toContain("helper = store");
  });

  it("adds a setting a file of the user's own is missing", async () => {
    const { ensureGitconfig, gitIdentityFor } = await import("@/lib/coder/gitconfig");
    const identity = gitIdentityFor({ name: "Ada", email: "ada@example.com" });
    const root = path.join(dir, IDENTITY);
    await fs.mkdir(root, { recursive: true });
    const target = path.join(root, ".gitconfig");
    await fs.writeFile(target, "[user]\n\tname = Ada\n\temail = ada@example.com\n", "utf8");

    await ensureGitconfig(USER, identity);

    const body = await fs.readFile(target, "utf8");
    expect(body).toContain("name = Ada");
    expect(body).toContain("defaultBranch = main");
    expect(body).toContain("pager = cat");
    expect(body).toContain(`directory = ${root}`);
  });

  it("falls back to the account's handle when it has no name", async () => {
    const { gitIdentityFor } = await import("@/lib/coder/gitconfig");
    expect(gitIdentityFor({ name: null, username: "ada", email: "ada@example.com" })).toEqual({
      name: "ada",
      email: "ada@example.com",
    });
    expect(gitIdentityFor({ name: "  ", username: null, email: "a@b.c" })).toEqual({
      name: "a",
      email: "a@b.c",
    });
  });
});

describe("refreshing the repo", () => {
  it("fetches the remote when the repo has one", async () => {
    await fetchOrigin(USER, "projects/saale");

    const commands = execOptions.map((options) => (options as { command: string }).command);
    expect(commands).toEqual([
      "git --no-pager remote get-url origin",
      "git --no-pager fetch --prune --quiet origin",
    ]);
  });

  it("does not fetch a repo with no remote", async () => {
    execResult = { stdout: "", stderr: "error: No such remote 'origin'", exitCode: 2 };

    await fetchOrigin(USER, "projects/local-only");

    expect(execOptions).toHaveLength(1);
  });

  it("keeps going when the fetch itself fails", async () => {
    execQueue = [
      { stdout: "git@github.com:acme/api.git", stderr: "", exitCode: 0 },
      { stdout: "", stderr: "fatal: could not resolve host: github.com", exitCode: 128 },
    ];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // An unreachable remote leaves a usable local copy; a chat still starts.
      await expect(fetchOrigin(USER, "projects/saale")).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not resolve host"));
    } finally {
      warn.mockRestore();
    }
  });

  it("starts a worktree from origin/<default> when it resolves", async () => {
    execResult = { stdout: "origin/main\n", stderr: "", exitCode: 0 };

    expect(await worktreeBaseRef(USER, { repoDir: "projects/saale", defaultBranch: "main" })).toBe(
      "origin/main",
    );
  });

  it("falls back to the local default branch when there is no remote ref", async () => {
    execResult = { stdout: "", stderr: "", exitCode: 1 };

    expect(await worktreeBaseRef(USER, { repoDir: "projects/saale", defaultBranch: "main" })).toBe(
      "main",
    );
  });

  it("reads the commit a ref points at, and nothing for a ref that is not there", async () => {
    execResult = { stdout: "abc123\n", stderr: "", exitCode: 0 };
    expect(await refSha(USER, "projects/saale", "origin/main")).toBe("abc123");

    execResult = { stdout: "", stderr: "", exitCode: 1 };
    expect(await refSha(USER, "projects/saale", "origin/gone")).toBe("");
  });
});

describe("isRepoFullyPushed", () => {
  const CLEAN = { stdout: "## main", stderr: "", exitCode: 0 };
  const HEAD = { stdout: "abc123\n", stderr: "", exitCode: 0 };

  it("is true for a clean repo with no remote to push to", async () => {
    execQueue = [CLEAN, HEAD, { stdout: "", stderr: "", exitCode: 0 }];

    await expect(isRepoFullyPushed(USER, "projects/local-only")).resolves.toBe(true);
  });

  it("is false for a clean repo with commits a remote does not have", async () => {
    execQueue = [
      CLEAN,
      HEAD,
      { stdout: "origin\n", stderr: "", exitCode: 0 },
      { stdout: "abc123\n", stderr: "", exitCode: 0 },
    ];

    await expect(isRepoFullyPushed(USER, "projects/saale")).resolves.toBe(false);
  });

  it("is true for a clean repo whose remote carries every commit", async () => {
    execQueue = [
      CLEAN,
      HEAD,
      { stdout: "origin\n", stderr: "", exitCode: 0 },
      { stdout: "", stderr: "", exitCode: 0 },
    ];

    await expect(isRepoFullyPushed(USER, "projects/saale")).resolves.toBe(true);
  });

  it("is false for a tree with changes, without asking about the remote", async () => {
    execQueue = [{ stdout: "## main\0 M src/a.ts\0", stderr: "", exitCode: 0 }, HEAD];

    await expect(isRepoFullyPushed(USER, "projects/local-only")).resolves.toBe(false);
    const commands = execOptions.map((options) => (options as { command: string }).command);
    expect(commands).not.toContain("git --no-pager remote");
  });
});

describe("resolveCommit", () => {
  it("resolves a ref to its full sha, or nothing when git cannot", async () => {
    execResult = { stdout: "abc123\n", stderr: "", exitCode: 0 };
    expect(await resolveCommit(USER, "projects/saale", "abc")).toBe("abc123");

    execResult = { stdout: "", stderr: "", exitCode: 1 };
    expect(await resolveCommit(USER, "projects/saale", "gone")).toBeNull();
  });
});

describe("readCommitDiff", () => {
  const Z = "\u0000";

  it("lists a commit's files with their line counts and its parent as the base", async () => {
    execQueue = [
      { stdout: "abc123 def456\n", stderr: "", exitCode: 0 },
      { stdout: `M${Z}src/a.ts${Z}A${Z}new.txt${Z}`, stderr: "", exitCode: 0 },
      { stdout: `1\t2\tsrc/a.ts${Z}3\t0\tnew.txt${Z}`, stderr: "", exitCode: 0 },
    ];

    expect(await readCommitDiff(USER, "worktrees/saale/c-1", "abc123")).toEqual([
      {
        path: "src/a.ts",
        originalPath: null,
        status: "M",
        added: 1,
        deleted: 2,
        baseRef: "def456",
      },
      { path: "new.txt", originalPath: null, status: "A", added: 3, deleted: 0, baseRef: "def456" },
    ]);
  });

  it("diffs a root commit against the empty tree", async () => {
    execQueue = [
      { stdout: "abc123\n", stderr: "", exitCode: 0 },
      { stdout: `A${Z}src/a.ts${Z}`, stderr: "", exitCode: 0 },
      { stdout: `1\t0\tsrc/a.ts${Z}`, stderr: "", exitCode: 0 },
    ];

    expect(await readCommitDiff(USER, "worktrees/saale/c-1", "abc123")).toEqual([
      { path: "src/a.ts", originalPath: null, status: "A", added: 1, deleted: 0, baseRef: null },
    ]);

    // rev-list, name-status, numstat — the tree form of the diff.
    expect((execOptions[1] as { command: string }).command).toContain(EMPTY_TREE);
  });

  it("diffs a merge against its first parent", async () => {
    execQueue = [
      { stdout: "m1 p1 p2\n", stderr: "", exitCode: 0 },
      { stdout: `M${Z}src/a.ts${Z}`, stderr: "", exitCode: 0 },
      { stdout: `1\t1\tsrc/a.ts${Z}`, stderr: "", exitCode: 0 },
    ];

    expect((await readCommitDiff(USER, "worktrees/saale/c-1", "m1"))[0]).toMatchObject({
      path: "src/a.ts",
      baseRef: "p1",
    });
    expect((execOptions[1] as { command: string }).command).toContain("p1 m1");
  });

  it("keeps a rename's origin and counts", async () => {
    execQueue = [
      { stdout: "abc123 def456\n", stderr: "", exitCode: 0 },
      { stdout: `R100${Z}keep.txt${Z}renamed.txt${Z}`, stderr: "", exitCode: 0 },
      { stdout: `1\t1\t${Z}keep.txt${Z}renamed.txt${Z}`, stderr: "", exitCode: 0 },
    ];

    expect(await readCommitDiff(USER, "worktrees/saale/c-1", "abc123")).toEqual([
      {
        path: "renamed.txt",
        originalPath: "keep.txt",
        status: "R",
        added: 1,
        deleted: 1,
        baseRef: "def456",
      },
    ]);
  });
});
