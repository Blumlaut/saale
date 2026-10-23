/**
 * Git, run inside the user's container.
 *
 * Every command goes through the sandbox service, so the repo, its objects and
 * its worktrees all belong to the sandbox account, and the app never runs git
 * against its own filesystem. Paths are workspace-relative and resolved through
 * `resolveCoderPath` before they reach a shell.
 *
 * `GIT_TERMINAL_PROMPT=0` because there is no terminal to answer a credential
 * prompt: without it a clone to a private repo hangs until the timeout instead
 * of failing with "could not read Username". `GIT_OPTIONAL_LOCKS=0` because the
 * panel refreshes status while the user and the agent write, and a refresh that
 * takes `.git/index.lock` would make their next commit fail.
 */

import { exec as sandboxExec } from "@/lib/sandbox/client";
import { resolveSandboxEnv } from "@/lib/sandbox/env";
import { userIdentity } from "@/lib/sandbox/identity";
import {
  parseLog,
  parseNumstat,
  parsePorcelainZ,
  parseStatusHeader,
  parseWorktreeList,
  type GitCommit,
  type GitNumstat,
  type GitStatus,
  type GitWorktreeEntry,
} from "./git-status";
import { coderPathRelativeTo, resolveCoderPath } from "./paths";

/** Variables every git command runs with. */
export const GIT_ENV: Record<string, string> = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_PAGER: "cat",
  LC_ALL: "C",
};

/** A clone is the only git command that may legitimately take minutes. */
export const CLONE_TIMEOUT_SECONDS = 600;

/** Everything else is local and must not hold a request open. */
const GIT_TIMEOUT_SECONDS = 60;

/** A worktree checkouts a lot of files, so it gets longer than a status. */
const WORKTREE_TIMEOUT_SECONDS = 120;

/** Longest error message kept from git's stderr. */
const MAX_ERROR_LENGTH = 2000;

export interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** git exited non-zero. `message` is the stderr the user should see. */
export class GitError extends Error {
  constructor(
    message: string,
    readonly args: readonly string[],
    readonly result: GitResult,
  ) {
    super(message);
    this.name = "GitError";
  }
}

/** Quote one argument for `sh -c`, which is what the service runs. */
export function shellQuote(argument: string): string {
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(argument)) return argument;
  return `'${argument.replace(/'/g, `'\\''`)}'`;
}

export interface RunGitOptions {
  /** Workspace-relative directory to run in. */
  cwd: string;
  args: readonly string[];
  /** Extra variables for this command (a user's `GH_TOKEN`, for `gh`). */
  env?: Record<string, string> | undefined;
  timeoutSeconds?: number | undefined;
  /** Return the result instead of throwing on a non-zero exit. */
  allowFailure?: boolean | undefined;
}

/** Run one command in the user's container, collecting its output. */
export async function runInWorkspace(
  userId: string,
  options: {
    /** Workspace-relative directory to run in. */
    cwd: string;
    command: string;
    env?: Record<string, string> | undefined;
    timeoutSeconds?: number | undefined;
  },
): Promise<GitResult> {
  const timeoutSeconds = options.timeoutSeconds ?? GIT_TIMEOUT_SECONDS;
  let stdout = "";
  let stderr = "";
  let exitCode = 1;

  for await (const event of sandboxExec({
    identity: userIdentity(userId),
    command: options.command,
    cwd: resolveCoderPath(userId, options.cwd),
    env: { ...GIT_ENV, ...(options.env ?? {}) },
    timeoutSeconds,
  })) {
    if (event.type === "chunk") {
      if (event.stream === "stdout") stdout += event.data.toString("utf8");
      else stderr += event.data.toString("utf8");
    } else if (event.type === "exit") {
      if (event.timedOut) {
        return {
          stdout,
          stderr: `${stderr}${stderr ? "\n" : ""}timed out after ${timeoutSeconds}s`,
          exitCode: 1,
        };
      }
      exitCode = event.exitCode;
    }
  }

  return { stdout, stderr, exitCode };
}

function failureMessage(result: GitResult): string {
  return (result.stderr.trim() || result.stdout.trim() || `git exited ${result.exitCode}`).slice(
    0,
    MAX_ERROR_LENGTH,
  );
}

/** Run one git command in the user's container. */
export async function runGit(userId: string, options: RunGitOptions): Promise<GitResult> {
  const result = await runInWorkspace(userId, {
    cwd: options.cwd,
    command: ["git", "--no-pager", ...options.args].map(shellQuote).join(" "),
    env: options.env,
    timeoutSeconds: options.timeoutSeconds,
  });
  if (result.exitCode !== 0 && !options.allowFailure) {
    throw new GitError(failureMessage(result), options.args, result);
  }
  return result;
}

/** `git init`, with the branch the project tracks. */
export async function initRepo(
  userId: string,
  options: { dir: string; defaultBranch: string },
): Promise<void> {
  await runGit(userId, { cwd: options.dir, args: ["init", "-b", options.defaultBranch] });
}

/**
 * Clone into a directory that does not exist yet.
 *
 * A `GH_TOKEN` among the user's sandbox variables sends the clone through `gh`,
 * so a private repo clones without the token reaching a config file. Without
 * one, plain `git clone` reaches a public repo and fails fast on a private one.
 */
export async function cloneRepo(
  userId: string,
  options: { dir: string; url: string },
): Promise<void> {
  const env: Record<string, string> = await resolveSandboxEnv(userId).catch((err: unknown) => {
    console.error(`Failed to load sandbox variables for cloning ${options.url}:`, err);
    return {};
  });
  const authorized = Boolean(env.GH_TOKEN);

  // `git clone` takes `--` before the URL so a URL starting with a dash is
  // read as a remote; `gh repo clone` has no such separator.
  const args = authorized
    ? ["gh", "repo", "clone", options.url, options.dir]
    : ["git", "clone", "--", options.url, options.dir];
  const result = await runInWorkspace(userId, {
    cwd: ".",
    command: args.map(shellQuote).join(" "),
    env: authorized ? env : undefined,
    timeoutSeconds: CLONE_TIMEOUT_SECONDS,
  });

  if (result.exitCode !== 0) throw new GitError(failureMessage(result), args, result);
}

/** A fetch talks to a remote, so it gets its own budget, above a local command. */
const FETCH_TIMEOUT_SECONDS = 120;

/**
 * Update the repo's remote-tracking refs, when it has a remote.
 *
 * A failure is reported and swallowed: a stale local copy still works, and an
 * unreachable remote must not stop a chat from starting.
 */
export async function fetchOrigin(userId: string, repoDir: string): Promise<void> {
  const remote = await runGit(userId, {
    cwd: repoDir,
    args: ["remote", "get-url", "origin"],
    allowFailure: true,
  });
  if (remote.exitCode !== 0) return;

  const result = await runGit(userId, {
    cwd: repoDir,
    args: ["fetch", "--prune", "--quiet", "origin"],
    allowFailure: true,
    timeoutSeconds: FETCH_TIMEOUT_SECONDS,
  });
  if (result.exitCode !== 0) {
    console.warn(`[coder] could not fetch ${repoDir}: ${failureMessage(result)}`);
  }
}

/**
 * The ref a new worktree starts from.
 *
 * The fetched remote tip is the point: branching off the local branch would
 * start every chat from whatever the clone had the day it was made.
 */
export async function worktreeBaseRef(
  userId: string,
  options: { repoDir: string; defaultBranch: string },
): Promise<string> {
  const remoteRef = `origin/${options.defaultBranch}`;
  const result = await runGit(userId, {
    cwd: options.repoDir,
    args: ["rev-parse", "--verify", "--quiet", remoteRef],
    allowFailure: true,
  });
  return result.exitCode === 0 ? remoteRef : options.defaultBranch;
}

/** The commit a ref points at, or "" when it does not resolve. */
export async function refSha(userId: string, dir: string, ref: string): Promise<string> {
  const result = await runGit(userId, {
    cwd: dir,
    args: ["rev-parse", "--verify", "--quiet", ref],
    allowFailure: true,
  });
  return result.exitCode === 0 ? result.stdout.trim() : "";
}

/** Whether a directory is the top of a git work tree. */
export async function isGitRepo(userId: string, dir: string): Promise<boolean> {
  const result = await runGit(userId, {
    cwd: dir,
    args: ["rev-parse", "--show-toplevel"],
    allowFailure: true,
  });
  return result.exitCode === 0;
}

/** The repo's HEAD commit, "" for a repo with no commits. */
export async function headSha(userId: string, dir: string): Promise<string> {
  const result = await runGit(userId, {
    cwd: dir,
    args: ["rev-parse", "--verify", "--quiet", "HEAD"],
    allowFailure: true,
  });
  return result.exitCode === 0 ? result.stdout.trim() : "";
}

/** Branch, position and changed files for a checkout. */
export async function readStatus(userId: string, dir: string): Promise<GitStatus> {
  const [status, head] = await Promise.all([
    runGit(userId, {
      cwd: dir,
      args: ["status", "--porcelain=v1", "-z", "-b", "--untracked-files=normal"],
    }),
    headSha(userId, dir),
  ]);
  return { ...parseStatusHeader(status.stdout), head, files: parsePorcelainZ(status.stdout) };
}

/** Every checkout of a repo, main worktree first. */
export async function listWorktrees(userId: string, repoDir: string): Promise<GitWorktreeEntry[]> {
  const { stdout } = await runGit(userId, {
    cwd: repoDir,
    args: ["worktree", "list", "--porcelain"],
  });
  return parseWorktreeList(stdout).map((entry) => ({
    ...entry,
    relative: coderPathRelativeTo(userId, entry.path) ?? entry.path,
  }));
}

/**
 * A checkout path for git, absolute.
 *
 * git resolves the path it is given against its own cwd, and that cwd is the
 * repo, so a workspace-relative path checks out inside the repo.
 */
function checkoutPath(userId: string, dir: string): string {
  return resolveCoderPath(userId, dir);
}

/**
 * Add a worktree on a new branch.
 *
 * The branch is created here rather than checked out, so two chats in one
 * project can never share a branch: the second `-b` fails and the caller
 * retries with a fresh name.
 */
export async function addWorktree(
  userId: string,
  options: { repoDir: string; dir: string; branch: string; base: string },
): Promise<void> {
  await runGit(userId, {
    cwd: options.repoDir,
    args: [
      "worktree",
      "add",
      "-b",
      options.branch,
      checkoutPath(userId, options.dir),
      options.base,
    ],
    timeoutSeconds: WORKTREE_TIMEOUT_SECONDS,
  });
}

/** Add a worktree on a branch that already exists. */
export async function addWorktreeOnBranch(
  userId: string,
  options: { repoDir: string; dir: string; branch: string },
): Promise<void> {
  await runGit(userId, {
    cwd: options.repoDir,
    args: ["worktree", "add", checkoutPath(userId, options.dir), options.branch],
    timeoutSeconds: WORKTREE_TIMEOUT_SECONDS,
  });
}

/** Remove a worktree. Without `force`, a dirty tree is git's decision to refuse. */
export async function removeWorktree(
  userId: string,
  options: { repoDir: string; dir: string; force?: boolean },
): Promise<void> {
  await runGit(userId, {
    cwd: options.repoDir,
    args: [
      "worktree",
      "remove",
      ...(options.force ? ["--force"] : []),
      checkoutPath(userId, options.dir),
    ],
    timeoutSeconds: WORKTREE_TIMEOUT_SECONDS,
  });
}

/** Drop metadata for worktrees whose directories are gone. */
export async function pruneWorktrees(userId: string, repoDir: string): Promise<void> {
  await runGit(userId, { cwd: repoDir, args: ["worktree", "prune"], allowFailure: true });
}

/** Line counts per changed path, staged and unstaged together against HEAD. */
export async function readNumstat(userId: string, dir: string): Promise<GitNumstat[]> {
  const { stdout } = await runGit(userId, {
    cwd: dir,
    args: ["diff", "--numstat", "-z", "HEAD"],
    allowFailure: true,
  });
  return parseNumstat(stdout);
}

/**
 * The unified diff for one path.
 *
 * An untracked file has nothing to diff against, so it is compared with an
 * empty one; git exits 1 for "the files differ", which is the normal case here.
 */
export async function readFileDiff(
  userId: string,
  options: { dir: string; path: string; staged?: boolean; untracked?: boolean },
): Promise<string> {
  const args = options.untracked
    ? ["diff", "--no-index", "--", "/dev/null", options.path]
    : options.staged
      ? ["diff", "--cached", "--", options.path]
      : ["diff", "--", options.path];

  const result = await runGit(userId, {
    cwd: options.dir,
    args,
    allowFailure: options.untracked === true,
  });
  return result.stdout || result.stderr;
}

/** One file's contents from a worktree, or null when it is missing. */
export async function readWorktreeFile(
  userId: string,
  dir: string,
  path: string,
): Promise<string | null> {
  const result = await runInWorkspace(userId, {
    cwd: dir,
    command: `cat ${shellQuote(path)}`,
    timeoutSeconds: 10,
  });
  if (result.exitCode !== 0) return null;
  return result.stdout;
}

/** Recent commits on the current branch. */
export async function readLog(userId: string, dir: string, limit = 20): Promise<GitCommit[]> {
  const format = ["%H", "%h", "%aI", "%an", "%s"].join("%x1f") + "%x1e";
  const { stdout } = await runGit(userId, {
    cwd: dir,
    args: ["log", `-n${limit}`, `--format=${format}`],
    allowFailure: true,
  });
  return parseLog(stdout);
}

/**
 * Whether a repo has nothing to lose: a clean tree and no commit that exists
 * only here.
 *
 * Used before a project's directory is deleted, so a checkout is never removed
 * while it holds the only copy of something.
 */
export async function isRepoFullyPushed(userId: string, dir: string): Promise<boolean> {
  const status = await readStatus(userId, dir);
  if (status.files.length > 0) return false;

  const unpushed = await runGit(userId, {
    cwd: dir,
    args: ["log", "--branches", "--not", "--remotes", "--format=%H"],
    allowFailure: true,
  });
  return unpushed.stdout.trim() === "";
}
