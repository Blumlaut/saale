/**
 * A commit's changes for the Diff tab: which paths it touched, and one path's
 * two sides.
 *
 * The git side runs in the user's container (git.ts); this module keeps the
 * ownership checks, the size guards and the response shapes, so the route
 * stays thin.
 */

import { assertRepoRelativePath, loadCoderSession } from "./changes";
import { checkoutOf } from "./checkout";
import { readCommitDiff, readBlobAt, resolveCommit, blobSizeAt } from "./git";
import type { CommitDiffFile } from "./git-status";

/**
 * Longest side a diff view will render. Monaco tokenizes a megabyte quickly,
 * and past that a side-by-side diff of two big files costs more than it is
 * worth; the UI offers the file list instead.
 */
const MAX_DIFF_FILE_BYTES = 1024 * 1024;

/** A sha as the panel shows it: 7 to 40 hex characters. */
const SHA_RE = /^[0-9a-f]{7,40}$/;

/** The paths a commit changed, with their status and line counts. */
export async function loadCommitDiff(
  userId: string,
  sessionId: string,
  sha: string,
): Promise<CommitDiffFile[] | null> {
  if (!SHA_RE.test(sha)) return null;
  const worktree = await worktreeFor(userId, sessionId);
  if (!worktree) return null;

  const fullSha = await resolveCommit(userId, worktree, sha);
  if (!fullSha) return null;
  return readCommitDiff(userId, worktree, fullSha);
}

/** One path's two sides at a commit, for the diff editor. */
export interface CommitDiffFileContent {
  path: string;
  /** True when git reports the path as binary, or a side exceeds the cap. */
  binary: boolean;
  original: string | null;
  modified: string | null;
}

export async function loadCommitDiffFile(
  userId: string,
  sessionId: string,
  sha: string,
  rawPath: string,
): Promise<CommitDiffFileContent | null | { error: string; status: number }> {
  if (!SHA_RE.test(sha)) return null;
  let path: string;
  try {
    path = assertRepoRelativePath(rawPath);
  } catch {
    return { error: "Invalid path", status: 400 };
  }

  const worktree = await worktreeFor(userId, sessionId);
  if (!worktree) return null;

  const fullSha = await resolveCommit(userId, worktree, sha);
  if (!fullSha) return null;

  const files = await readCommitDiff(userId, worktree, fullSha);
  const file = files.find(
    (candidate) => candidate.path === path || candidate.originalPath === path,
  );
  if (!file) {
    return { error: "Path is not part of this commit", status: 404 };
  }
  if (file.added === null || file.deleted === null) {
    return { path: file.path, binary: true, original: null, modified: null };
  }

  const baseRef = file.baseRef;
  const [baseSize, headSize] = await Promise.all([
    baseRef ? blobSizeAt(userId, worktree, baseRef, file.path) : Promise.resolve(0),
    file.status === "D" ? Promise.resolve(0) : blobSizeAt(userId, worktree, fullSha, file.path),
  ]);
  if ((baseSize ?? 0) > MAX_DIFF_FILE_BYTES || (headSize ?? 0) > MAX_DIFF_FILE_BYTES) {
    return { path: file.path, binary: true, original: null, modified: null };
  }

  const [original, modified] = await Promise.all([
    baseRef ? readBlobAt(userId, worktree, baseRef, file.path) : Promise.resolve(""),
    file.status === "D" ? Promise.resolve("") : readBlobAt(userId, worktree, fullSha, file.path),
  ]);
  return {
    path: file.path,
    binary: false,
    original: original ?? "",
    modified: modified ?? "",
  };
}

/** The chat's checkout path, or null for a chat with nothing to diff. */
async function worktreeFor(userId: string, sessionId: string): Promise<string | null> {
  const session = await loadCoderSession(userId, sessionId);
  return session ? (checkoutOf(session)?.path ?? null) : null;
}
