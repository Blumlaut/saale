import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const execOptions: Array<Record<string, unknown>> = [];
let execResult: { stdout: string; stderr: string; exitCode: number } = {
  stdout: "",
  stderr: "",
  exitCode: 0,
};

vi.mock("@/lib/sandbox/client", () => ({
  exec: async function* (options: Record<string, unknown>) {
    execOptions.push(options);
    yield { type: "chunk", stream: "stdout", data: Buffer.from(execResult.stdout) };
    yield { type: "chunk", stream: "stderr", data: Buffer.from(execResult.stderr) };
    yield { type: "exit", exitCode: execResult.exitCode, timedOut: false, durationMs: 1 };
  },
}));

vi.mock("@/lib/sandbox/env", () => ({
  resolveSandboxEnv: async () => ({ GH_TOKEN: "secret-token" }),
}));

import {
  GitError,
  addWorktree,
  addWorktreeOnBranch,
  cloneRepo,
  removeWorktree,
  runGit,
  shellQuote,
} from "@/lib/coder/git";

const USER = "user-1";

beforeEach(() => {
  execOptions.length = 0;
  execResult = { stdout: "", stderr: "", exitCode: 0 };
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
    expect(options.cwd).toBe("/workspaces/user-user-1/projects/saale");
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
  const root = "/workspaces/user-user-1";

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
});

describe("cloneRepo", () => {
  it("clones with plain git when the user has no token", async () => {
    await cloneRepo(USER, { dir: "projects/saale", url: "https://github.com/Blumlaut/saale.git" });
    const options = execOptions[0] as { command: string };
    expect(options.command).toBe(
      "git clone -- https://github.com/Blumlaut/saale.git projects/saale",
    );
  });

  it("clones through gh when authorizing from the environment", async () => {
    await cloneRepo(USER, {
      dir: "projects/private",
      url: "https://github.com/Blumlaut/private.git",
      authFromEnv: true,
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
    expect(target).toBe(path.join(dir, "user-user-1", ".gitconfig"));
    expect(body).toContain("name = Ada");
    expect(body).toContain("email = ada@example.com");
    expect(body).toContain("defaultBranch = main");
    expect(body).toContain("ff = only");
    expect(body).toContain(`directory = ${path.join(dir, "user-user-1")}`);
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
