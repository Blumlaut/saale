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

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { get as getPooledEntry, getPoolKey, remove as removePooled } from "@/lib/pi/agent-pool";
import {
  addWorktree,
  addWorktreeOnBranch,
  fetchOrigin,
  GitError,
  headSha,
  listWorktrees,
  pruneWorktrees,
  refSha,
  removeWorktree,
  runGit,
  worktreeBaseRef,
} from "./git";
import {
  coderPathRelativeTo,
  resolveCoderPath,
  workspaceDirectoryExists,
  worktreePath,
} from "./paths";
import {
  excludeEnvFiles,
  runSetupScript,
  storedEnvFiles,
  writeEnvFiles,
  type EnvFile,
} from "./project-config";
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
  envFiles: unknown;
  setupScript: string | null;
}

/** How stale a repo may be before a new chat refreshes it. */
const FETCH_TTL_MS = 5 * 60_000;

/** When each repo was last fetched, so a burst of chats fetches once. */
const lastFetched = new Map<string, number>();

/** git says the branch is already there, so there is nothing to create. */
const BRANCH_EXISTS_PATTERN = /branch named .* already exists|already exists/i;

/** A concurrent git process holds the index or a ref. */
const LOCK_ERROR_PATTERN = /index\.lock|cannot lock ref/i;

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

/**
 * Drop a checkout that holds `branch` at some other path.
 *
 * git refuses to check out one branch twice, and a branch outlives the row that
 * named it: a chat whose directory moved, or one deleted by hand, leaves the
 * old checkout registered. The row decides where the checkout belongs, so the
 * other one goes first. No `--force`: a dirty checkout still stops here.
 */
async function releaseBranch(
  userId: string,
  options: { repoDir: string; dir: string; branch: string },
): Promise<void> {
  const wanted = resolveCoderPath(userId, options.dir);
  const entries = await listWorktrees(userId, options.repoDir);
  const stale = entries.find((entry) => entry.branch === options.branch && entry.path !== wanted);
  if (!stale) return;

  const relative = coderPathRelativeTo(userId, stale.path);
  if (!relative) {
    throw new Error(
      `Branch ${options.branch} is checked out outside the workspace at ${stale.path}`,
    );
  }
  console.warn(`[coder] moving ${options.branch} out of ${relative}`);
  await removeWorktree(userId, { repoDir: options.repoDir, dir: relative });
}

/**
 * Add a worktree on `branch`, creating the branch when it does not exist.
 *
 * A recreated worktree's branch outlives its checkout, so `-b` is refused and
 * the existing branch is checked out at the same name instead.
 */
async function addWorktreeForBranch(
  userId: string,
  options: {
    repoDir: string;
    dir: string;
    branch: string;
    base: string;
    envFiles: EnvFile[];
  },
): Promise<void> {
  try {
    await addWorktree(userId, options);
  } catch (err) {
    if (!(err instanceof GitError) || !BRANCH_EXISTS_PATTERN.test(err.message)) throw err;
    await releaseBranch(userId, options);
    await addWorktreeOnBranch(userId, options);
  }

  // The container is started in this directory, so a chat whose checkout is not
  // here would come up with a shell that cannot start.
  if (!(await workspaceDirectoryExists(userId, options.dir))) {
    throw new Error(`Worktree ${options.dir} was not created`);
  }

  // Written before the chat's first command, and kept out of `git status` so a
  // checkout with a `.env` in it still removes cleanly.
  await writeEnvFiles(userId, options.dir, options.envFiles);
  await excludeEnvFiles(userId, options.repoDir, options.envFiles);
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

/**
 * Bring the repo up to date before a worktree branches off it.
 *
 * A project is cloned once and never touched again, so without this every chat
 * would start from the day the project was made.
 */
async function refreshRepo(userId: string, repoDir: string): Promise<void> {
  const last = lastFetched.get(repoDir) ?? 0;
  if (Date.now() - last < FETCH_TTL_MS) return;
  lastFetched.set(repoDir, Date.now());
  await fetchOrigin(userId, repoDir);
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
    select: {
      id: true,
      slug: true,
      repoPath: true,
      defaultBranch: true,
      envFiles: true,
      setupScript: true,
    },
  });
  if (!project) throw new Error(`Project not found: ${chat.projectId}`);

  const result = await withProjectLock(project.id, () =>
    withLockRetry(() => resolveWorktree(userId, sessionId, project)),
  );
  if (result.changed) await evictPooledAgent(userId, sessionId);
  // Outside the lock: an install takes minutes, and a second chat in the same
  // project must not wait for it.
  if (result.created) {
    await runSetupScript(userId, result.path, project.setupScript);
  }
  return { path: result.path, branch: result.branch };
}

async function resolveWorktree(
  userId: string,
  sessionId: string,
  project: ProjectRow,
): Promise<EnsuredWorktree & { changed: boolean; created: boolean }> {
  const envFiles = storedEnvFiles(project.envFiles);
  const row = await prisma.coderWorktree.findUnique({ where: { sessionId } });
  if (row) {
    if (row.projectId !== project.id) {
      throw new Error(`Worktree ${row.path} belongs to another project`);
    }
    if (await workspaceDirectoryExists(userId, row.path)) {
      return { path: row.path, branch: row.branch, changed: false, created: false };
    }
    // The row is what the panel shows; prune drops git's half of a checkout
    // that was deleted by hand, so the branch can be checked out again.
    await pruneWorktrees(userId, project.repoPath);
    await addWorktreeForBranch(userId, {
      repoDir: project.repoPath,
      dir: row.path,
      branch: row.branch,
      base: row.baseSha,
      envFiles,
    });
    return { path: row.path, branch: row.branch, changed: true, created: true };
  }

  const path = worktreePath(project.slug, sessionId);
  const branch = coderBranchName(coderChatSlug(sessionId));
  await refreshRepo(userId, project.repoPath);
  const headSha = await ensureBaseCommit(userId, project.repoPath);
  const base = await worktreeBaseRef(userId, {
    repoDir: project.repoPath,
    defaultBranch: project.defaultBranch,
  });
  await addWorktreeForBranch(userId, {
    repoDir: project.repoPath,
    dir: path,
    branch,
    base,
    envFiles,
  });
  const baseSha = (await refSha(userId, project.repoPath, base)) || headSha;

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
      // The winner runs the setup script. it made the checkout.
      return { path: raced.path, branch: raced.branch, changed: true, created: false };
    }
    throw err;
  }

  return { path, branch, changed: true, created: true };
}
