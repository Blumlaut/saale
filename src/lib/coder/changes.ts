/**
 * What the coder panel shows about a chat's worktree.
 *
 * The status, the line counts and the log are read from the same git the model
 * commits with, so the panel can never describe a tree the model does not see.
 * Everything is scoped to the chat's owner and resolves through the stored
 * worktree path, never through a path the client sends.
 */

import { prisma } from "@/lib/db";
import { readFileDiff, readLog, readNumstat, readStatus, readWorktreeFile } from "./git";
import type { GitCommit, GitStatus } from "./git-status";

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
}

/** A runnable script found in the worktree's package.json. */
export interface CoderScript {
  name: string;
  command: string;
}

/** A chat's worktree and everything git says about it. */
export interface CoderSessionState {
  worktree: { path: string; branch: string; baseSha: string } | null;
  project: { id: string; name: string; slug: string } | null;
  branch: string;
  head: string;
  upstream: string;
  ahead: number;
  behind: number;
  changes: CoderChange[];
  commits: GitCommit[];
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
      project: { select: { id: true, name: true, slug: true } },
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
 * The worktree's state, or an empty state when it does not exist yet.
 *
 * A git failure is not an empty state: a status that cannot be read is
 * surfaced, because a panel that silently shows "no changes" over a tree that
 * failed to read is worse than one that says it could not look.
 */
export async function loadSessionState(
  userId: string,
  sessionId: string,
): Promise<CoderSessionState | null> {
  const session = await loadCoderSession(userId, sessionId);
  if (!session) return null;
  if (!session.coderWorktree || session.coderWorktree.status !== "active") {
    return { ...NOT_READY, project: session.project };
  }

  const worktree = session.coderWorktree;
  const [status, numstat, commits, packageJson] = await Promise.all([
    readStatus(userId, worktree.path),
    readNumstat(userId, worktree.path),
    readLog(userId, worktree.path),
    readWorktreeFile(userId, worktree.path, "package.json"),
  ]);

  return {
    worktree: { path: worktree.path, branch: worktree.branch, baseSha: worktree.baseSha },
    project: session.project,
    branch: status.branch || worktree.branch,
    head: status.head,
    upstream: status.upstream,
    ahead: status.ahead,
    behind: status.behind,
    changes: mergeChanges(status, numstat),
    commits,
    scripts: parsePackageScripts(packageJson),
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
    };
  });
}

/** The unified diff for one path in a chat's worktree. */
export async function loadSessionDiff(
  userId: string,
  sessionId: string,
  options: { path: string; staged?: boolean },
): Promise<string | null> {
  const session = await loadCoderSession(userId, sessionId);
  if (!session?.coderWorktree || session.coderWorktree.status !== "active") return null;

  const files = await readStatus(userId, session.coderWorktree.path);
  const entry = files.files.find((file) => file.path === options.path);
  const untracked = entry ? entry.index === "?" || entry.worktree === "?" : false;

  return readFileDiff(userId, {
    dir: session.coderWorktree.path,
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
    .map(([name, command]) => ({ name, command: String(command ?? "") }));
}
