/**
 * A coder chat's worktree, built on the first message.
 *
 * The worktree is the only directory a coder agent ever runs in, so it is made
 * before the session that will run in it. Everything here is idempotent: the
 * row is the record of what was made, and git is asked whether the checkout is
 * still there instead of trusting the row.
 *
 * Serialized per project, because `git worktree add` and `git worktree prune`
 * both touch the repo's own `.git/worktrees` and fail on each other's locks
 * when two chats start at once.
 */

import fs from "node:fs/promises";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { isNotFoundError } from "@/lib/files/errors";
import { get as getPooledEntry, getPoolKey, remove as removePooled } from "@/lib/pi/agent-pool";
import { addWorktree, GitError, headSha, pruneWorktrees, runGit } from "./git";
import { resolveCoderPath, worktreePath } from "./paths";
import { coderBranchName, coderChatSlug } from "./slug";

/** The branch and directory a chat runs in. */
export interface EnsuredWorktree {
  /** Workspace-relative path, e.g. `worktrees/saale/c-1a2b3c4d`. */
  path: string;
  branch: string;
}

/** The project a chat's worktree belongs to. */
interface ProjectRow {
  id: string;
  slug: string;
  repoPath: string;
  defaultBranch: string;
}

/** git says the branch is already there, so there is nothing to create. */
const BRANCH_EXISTS_PATTERN = /branch named .* already exists|already exists/i;

/** A concurrent git process holds the index or a ref. */
const LOCK_ERROR_PATTERN = /index\.lock|cannot lock ref/i;

/** Longest a worktree add may take. a big repo checks out a lot of files. */
const WORKTREE_ADD_TIMEOUT_SECONDS = 120;

/**
 * One promise chain per project, so worktree bookkeeping in one repo never
 * overlaps. Keyed by project id, not by path: the row is the shared thing.
 */
const projectLocks = new Map<string, Promise<unknown>>();

async function withProjectLock<T>(projectId: string, task: () => Promise<T>): Promise<T> {
  const previous = projectLocks.get(projectId) ?? Promise.resolve();
  const run = previous.then(task, task);
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  projectLocks.set(projectId, settled);
  try {
    return await run;
  } finally {
    // Only the last task drops the entry; an earlier one leaving it would let
    // the next task start beside the one still queued.
    if (projectLocks.get(projectId) === settled) projectLocks.delete(projectId);
  }
}

/** Run a git step again once when another process held a lock. */
async function withLockRetry<T>(task: () => Promise<T>): Promise<T> {
  try {
    return await task();
  } catch (err) {
    if (!(err instanceof GitError) || !LOCK_ERROR_PATTERN.test(err.message)) throw err;
    console.warn(`[coder] git was locked, retrying: ${err.message}`);
    return task();
  }
}

async function directoryExists(userId: string, relative: string): Promise<boolean> {
  try {
    const stat = await fs.stat(resolveCoderPath(userId, relative));
    return stat.isDirectory();
  } catch (err) {
    if (isNotFoundError(err)) return false;
    throw err;
  }
}

/**
 * Add a worktree on `branch`, creating the branch when it does not exist.
 *
 * A recreated worktree's branch outlives its checkout, so `-b` is refused and
 * the existing branch is checked out at the same name instead.
 */
async function addWorktreeForBranch(
  userId: string,
  options: { repoDir: string; dir: string; branch: string; base: string },
): Promise<void> {
  try {
    await addWorktree(userId, options);
  } catch (err) {
    if (!(err instanceof GitError) || !BRANCH_EXISTS_PATTERN.test(err.message)) throw err;
    await runGit(userId, {
      cwd: options.repoDir,
      args: ["worktree", "add", options.dir, options.branch],
      timeoutSeconds: WORKTREE_ADD_TIMEOUT_SECONDS,
    });
  }
}

/**
 * The repo's HEAD commit, making one when the repo has none.
 *
 * `git worktree add` needs a commit to branch from, and a freshly `git init`-ed
 * project has no history at all. An empty commit costs nothing and gives the
 * first chat something to start from.
 */
async function ensureBaseCommit(userId: string, repoDir: string): Promise<string> {
  const head = await headSha(userId, repoDir);
  if (head) return head;

  await runGit(userId, {
    cwd: repoDir,
    args: ["commit", "--allow-empty", "-m", "Initial commit"],
  });
  return headSha(userId, repoDir);
}

/** Drop the pooled agent for a chat whose directory just changed. */
async function evictPooledAgent(userId: string, sessionId: string): Promise<void> {
  const poolKey = getPoolKey(userId, sessionId);
  if (!getPooledEntry(poolKey)) return;
  // The cwd is baked into the session, so a rebuilt one is the only safe move.
  await removePooled(poolKey);
}

/**
 * Make sure this chat has a worktree, and return the one it runs in.
 *
 * Three cases, in the order they happen: a row whose directory is still there
 * is used as it is; a row whose directory went away is rebuilt at the same
 * path and branch; no row means a new branch off the project's default branch.
 */
export async function ensureWorktree(userId: string, sessionId: string): Promise<EnsuredWorktree> {
  const chat = await prisma.chatSession.findFirst({
    where: { id: sessionId, userId },
    select: { id: true, projectId: true },
  });
  if (!chat) throw new Error(`Chat not found: ${sessionId}`);
  if (!chat.projectId) throw new Error(`Chat ${sessionId} does not belong to a project`);

  // Scoped by userId as well as id: a chat row pointing at another user's
  // project must not reach their repo.
  const project = await prisma.coderProject.findFirst({
    where: { id: chat.projectId, userId },
    select: { id: true, slug: true, repoPath: true, defaultBranch: true },
  });
  if (!project) throw new Error(`Project not found: ${chat.projectId}`);

  const result = await withProjectLock(project.id, () =>
    withLockRetry(() => resolveWorktree(userId, sessionId, project)),
  );
  if (result.changed) await evictPooledAgent(userId, sessionId);
  return { path: result.path, branch: result.branch };
}

async function resolveWorktree(
  userId: string,
  sessionId: string,
  project: ProjectRow,
): Promise<EnsuredWorktree & { changed: boolean }> {
  const row = await prisma.coderWorktree.findUnique({ where: { sessionId } });
  if (row) {
    if (row.projectId !== project.id) {
      throw new Error(`Worktree ${row.path} belongs to another project`);
    }
    if (await directoryExists(userId, row.path)) {
      return { path: row.path, branch: row.branch, changed: false };
    }
    // The row is what the panel shows; prune drops git's half of a checkout
    // that was deleted by hand, so the branch can be checked out again.
    await pruneWorktrees(userId, project.repoPath);
    await addWorktreeForBranch(userId, {
      repoDir: project.repoPath,
      dir: row.path,
      branch: row.branch,
      base: row.baseSha,
    });
    return { path: row.path, branch: row.branch, changed: true };
  }

  const path = worktreePath(project.slug, sessionId);
  const branch = coderBranchName(coderChatSlug(sessionId));
  const baseSha = await ensureBaseCommit(userId, project.repoPath);
  await addWorktreeForBranch(userId, {
    repoDir: project.repoPath,
    dir: path,
    branch,
    base: project.defaultBranch,
  });

  try {
    await prisma.coderWorktree.create({
      data: { projectId: project.id, sessionId, path, branch, baseSha },
    });
  } catch (err) {
    // Two processes raced for the same chat. The path and branch are derived
    // from the session id, so the row the winner wrote describes this checkout.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const raced = await prisma.coderWorktree.findUnique({ where: { sessionId } });
      if (!raced) throw err;
      return { path: raced.path, branch: raced.branch, changed: true };
    }
    throw err;
  }

  return { path, branch, changed: true };
}
