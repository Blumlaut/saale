/**
 * One writer per repo.
 *
 * Worktree bookkeeping and the panel's git actions both take this lock, keyed by
 * project id, so a `push` from a button and a `worktree add` for another chat
 * never overlap on the same objects. The agent's own git still runs beside
 * these, which is why every command also runs with `GIT_OPTIONAL_LOCKS=0`.
 */

import { GitError } from "./git";

/** A concurrent git process holds the index or a ref. */
const LOCK_ERROR_PATTERN = /index\.lock|cannot lock ref/i;

const repoLocks = new Map<string, Promise<unknown>>();

/** Serialize work on one repo. The row is the shared thing, so the key is its id. */
export async function withRepoLock<T>(projectId: string, task: () => Promise<T>): Promise<T> {
  const previous = repoLocks.get(projectId) ?? Promise.resolve();
  const run = previous.then(task, task);
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  repoLocks.set(projectId, settled);
  try {
    return await run;
  } finally {
    // Only the last task drops the entry; an earlier one leaving it would let
    // the next task start beside the one still queued.
    if (repoLocks.get(projectId) === settled) repoLocks.delete(projectId);
  }
}

/** Run a git step again once when another process held a lock. */
export async function withLockRetry<T>(task: () => Promise<T>): Promise<T> {
  try {
    return await task();
  } catch (err) {
    if (!(err instanceof GitError) || !LOCK_ERROR_PATTERN.test(err.message)) throw err;
    console.warn(`[coder] git was locked, retrying: ${err.message}`);
    return task();
  }
}
