/**
 * What the coder panel shows about a chat's worktree.
 *
 * The status, the line counts and the log are read from the same git the model
 * commits with, so the panel can never describe a tree the model does not see.
 * Everything is scoped to the chat's owner and resolves through the stored
 * worktree path, never through a path the client sends.
 */

import { prisma } from "@/lib/db";
import { checkoutOf, type ChatMode } from "./checkout";
import {
  readFileDiff,
  readLog,
  readNumstat,
  readRemotes,
  readStashCount,
  readStatus,
  readUnpushedShas,
  readWorktreeFile,
} from "./git";
import { isConflict, type GitCommit, type GitRemote, type GitStatus } from "./git-status";

/** How many commits the panel reads when the caller does not say. */
export const DEFAULT_COMMIT_LIMIT = 20;

/** The most one status read will carry, so a huge history cannot stall a poll. */
export const MAX_COMMIT_LIMIT = 200;

/** One changed path as the panel lists it. */
export interface CoderChange {
  path: string;
  originalPath: string | null;
  /** Line counts, null for a binary file or an untracked one. */
  added: number | null;
  deleted: number | null;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  /** git could not merge this path: the worktree needs a decision. */
  conflicted: boolean;
}

/** One commit as the history lists it. */
export interface CoderCommit extends GitCommit {
  /** False when the branch's upstream does not have it, null when there is no upstream. */
  pushed: boolean | null;
}

/** A runnable script found in the worktree's package.json. */
export interface CoderScript {
  name: string;
  command: string;
  runCommand: string;
}

/** A chat's checkout and everything git says about it. */
export interface CoderSessionState {
  worktree: { path: string; branch: string; baseSha: string; mode: ChatMode } | null;
  project: { id: string; name: string; slug: string } | null;
  branch: string;
  head: string;
  upstream: string;
  ahead: number;
  behind: number;
  changes: CoderChange[];
  commits: CoderCommit[];
  /** True when the branch has more history than this read carries. */
  commitsTruncated: boolean;
  /** Where the branch pushes to and pulls from, empty for a project with no remote. */
  remotes: GitRemote[];
  /** How many stashes the repo holds. */
  stashes: number;
  scripts: CoderScript[];
}

/** A chat whose worktree has not been built yet, or is gone. */
const NOT_READY: CoderSessionState = {
  worktree: null,
  project: null,
  branch: "",
  head: "",
  upstream: "",
  ahead: 0,
  behind: 0,
  changes: [],
  commits: [],
  commitsTruncated: false,
  remotes: [],
  stashes: 0,
  scripts: [],
};

/**
 * A chat and its worktree, scoped to the owner.
 *
 * Returns null for a chat that does not exist or belongs to someone else. the
 * route answers 404 without saying which.
 */
export async function loadCoderSession(userId: string, sessionId: string) {
  return prisma.chatSession.findFirst({
    where: { id: sessionId, userId, projectId: { not: null } },
    select: {
      id: true,
      projectId: true,
      project: { select: { id: true, name: true, slug: true, repoPath: true, chatMode: true } },
      coderWorktree: {
        select: { path: true, branch: true, baseSha: true, status: true },
      },
    },
  });
}

/** Reject a path that is not a plain repo-relative one. */
export function assertRepoRelativePath(path: string): string {
  const cleaned = path.trim();
  if (
    !cleaned ||
    cleaned.startsWith("/") ||
    cleaned.includes("\0") ||
    cleaned.split("/").some((segment) => segment === ".." || segment === "." || segment === "")
  ) {
    throw new Error(`Not a repo-relative path: ${path}`);
  }
  return cleaned;
}

/**
 * The checkout's state, or an empty state when it does not exist yet.
 *
 * A git failure is not an empty state: a status that cannot be read is
 * surfaced, because a panel that silently shows "no changes" over a tree that
 * failed to read is worse than one that says it could not look.
 */
export async function loadSessionState(
  userId: string,
  sessionId: string,
  options: { commitLimit?: number } = {},
): Promise<CoderSessionState | null> {
  const session = await loadCoderSession(userId, sessionId);
  if (!session) return null;
  const checkout = checkoutOf(session);
  if (!checkout) return { ...NOT_READY, project: session.project };

  const dir = checkout.path;
  const limit = Math.min(
    Math.max(options.commitLimit ?? DEFAULT_COMMIT_LIMIT, 1),
    MAX_COMMIT_LIMIT,
  );
  const [status, numstat, log, remotes, stashes, packageJson, makefile, pyproject, composerJson] =
    await Promise.all([
      readStatus(userId, dir),
      readNumstat(userId, dir),
      // One extra, so the panel can say whether there is more history.
      readLog(userId, dir, limit + 1),
      readRemotes(userId, dir),
      readStashCount(userId, dir),
      readWorktreeFile(userId, dir, "package.json"),
      readWorktreeFile(userId, dir, "Makefile"),
      readWorktreeFile(userId, dir, "pyproject.toml"),
      readWorktreeFile(userId, dir, "composer.json"),
    ]);

  const sampled = log.slice(0, limit);
  const unpushed = status.upstream
    ? await readUnpushedShas(userId, dir, status.upstream).catch((err: unknown) => {
        // A missing or stale upstream ref costs the badge, not the panel.
        console.error(`Failed to read unpushed commits for ${dir}:`, err);
        return null;
      })
    : null;

  return {
    // The branch git reports is the live one: a shared checkout can have been
    // switched by hand since the chat opened.
    worktree: { ...checkout, branch: status.branch || checkout.branch },
    project: session.project,
    branch: status.branch || checkout.branch,
    head: status.head,
    upstream: status.upstream,
    ahead: status.ahead,
    behind: status.behind,
    changes: mergeChanges(status, numstat),
    commits: sampled.map((commit) => ({
      ...commit,
      pushed: unpushed === null ? null : !unpushed.has(commit.sha),
    })),
    commitsTruncated: log.length > limit,
    remotes,
    stashes,
    scripts: [
      ...parsePackageScripts(packageJson),
      ...parseMakefile(makefile),
      ...parsePyproject(pyproject),
      ...parseComposer(composerJson),
    ],
  };
}

/** Status entries with the line counts git reports for the same paths. */
function mergeChanges(status: GitStatus, numstat: Awaited<ReturnType<typeof readNumstat>>) {
  const counts = new Map(numstat.map((entry) => [entry.path, entry]));
  return status.files.map((file): CoderChange => {
    const count = counts.get(file.path);
    return {
      path: file.path,
      originalPath: file.originalPath,
      added: count?.added ?? null,
      deleted: count?.deleted ?? null,
      staged: file.index !== " " && file.index !== "?",
      unstaged: file.worktree !== " " && file.worktree !== "?",
      untracked: file.index === "?" || file.worktree === "?",
      conflicted: isConflict(file.index, file.worktree),
    };
  });
}

/** The unified diff for one path in a chat's checkout. */
export async function loadSessionDiff(
  userId: string,
  sessionId: string,
  options: { path: string; staged?: boolean },
): Promise<string | null> {
  const session = await loadCoderSession(userId, sessionId);
  const checkout = session ? checkoutOf(session) : null;
  if (!checkout) return null;

  const files = await readStatus(userId, checkout.path);
  const entry = files.files.find((file) => file.path === options.path);
  const untracked = entry ? entry.index === "?" || entry.worktree === "?" : false;

  return readFileDiff(userId, {
    dir: checkout.path,
    path: assertRepoRelativePath(options.path),
    staged: options.staged === true,
    untracked,
  });
}

/** Extract the scripts worth offering from a package.json's contents. */
function parsePackageScripts(raw: string | null): CoderScript[] {
  if (!raw) return [];
  let parsed: { scripts?: Record<string, unknown> } | null = null;
  try {
    parsed = JSON.parse(raw) as { scripts?: Record<string, unknown> };
  } catch {
    return [];
  }
  const scripts = parsed?.scripts ?? {};
  // Only scripts that start or run a dev environment: the rest (lint, typecheck,
  // format) are not things a button in this panel should launch.
  const relevant = /^(dev|start|preview|serve|watch)(:|$)/i;
  return Object.entries(scripts)
    .filter(([name]) => relevant.test(name))
    .map(([name, command]) => ({
      name,
      command: String(command ?? ""),
      runCommand: `npm run ${name}`,
    }));
}

/** Makefile targets that look like dev servers. */
function parseMakefile(raw: string | null): CoderScript[] {
  if (!raw) return [];
  const relevant = /^(dev|start|preview|serve|watch|run)(:|$)/i;
  const scripts: CoderScript[] = [];
  for (const line of raw.split("\n")) {
    const match = line.match(/^([A-Za-z0-9_.-]+)\s*:/);
    if (!match) continue;
    const name = match[1] as string;
    if (name.startsWith(".")) continue;
    if (!relevant.test(name)) continue;
    scripts.push({ name, command: "make target", runCommand: `make ${name}` });
  }
  return scripts;
}

/** Poetry/poe scripts from pyproject.toml. */
function parsePyproject(raw: string | null): CoderScript[] {
  if (!raw) return [];
  const relevant = /^(dev|start|preview|serve|watch|run)(:|$)/i;
  const scripts: CoderScript[] = [];
  // crude: look for [tool.poetry.scripts] or [tool.poe.tasks] sections
  let inSection = false;
  for (const line of raw.split("\n")) {
    if (/^\[tool\.(poetry\.scripts|poe\.tasks)\]/.test(line.trim())) {
      inSection = true;
      continue;
    }
    if (/^\[/.test(line.trim())) {
      inSection = false;
      continue;
    }
    if (!inSection) continue;
    const match = line.match(/^([A-Za-z0-9_.-]+)\s*=/);
    if (!match) continue;
    const name = match[1] as string;
    if (!relevant.test(name)) continue;
    scripts.push({ name, command: "python task", runCommand: `poetry run ${name}` });
  }
  return scripts;
}

/** Composer scripts from composer.json. */
function parseComposer(raw: string | null): CoderScript[] {
  if (!raw) return [];
  let parsed: { scripts?: Record<string, unknown> } | null = null;
  try {
    parsed = JSON.parse(raw) as { scripts?: Record<string, unknown> };
  } catch {
    return [];
  }
  const scripts = parsed?.scripts ?? {};
  const relevant = /^(dev|start|preview|serve|watch|run)(:|$)/i;
  return Object.entries(scripts)
    .filter(([name]) => relevant.test(name))
    .map(([name, command]) => ({
      name,
      command: String(command ?? ""),
      runCommand: `composer run ${name}`,
    }));
}
