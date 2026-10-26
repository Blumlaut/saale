/**
 * One file out of a chat's checkout as bytes.
 *
 * An image has no text diff, so the panel shows the picture instead: the
 * worktree's copy for an uncommitted change, or the copy a commit holds.
 */

import { MAX_PREVIEW_BYTES } from "@/lib/files/config";
import { resolveMimeType } from "@/lib/files/mime";
import { readWorkspaceFile } from "@/lib/files/workspace-file";
import { assertRepoRelativePath, loadCoderSession } from "./changes";
import { checkoutOf } from "./checkout";
import { COMMIT_SHA_RE } from "./commit-diff";
import { blobSizeAt, readBlobBytesAt, resolveCommit } from "./git";

/** A file's bytes, ready to serve to a preview. */
export interface SessionBlob {
  path: string;
  mimeType: string;
  buffer: Uint8Array<ArrayBuffer>;
  /** A commit's copy never changes; a worktree file does. */
  immutable: boolean;
}

/** Why a path has no bytes to show. */
export interface SessionBlobError {
  error: string;
  status: number;
}

/**
 * A path's bytes from a chat's checkout, or from one commit of it when `sha`
 * names a commit.
 *
 * Returns null for a chat with no checkout, which the route answers 404.
 */
export async function loadSessionBlob(
  userId: string,
  sessionId: string,
  options: { path: string; sha?: string | null },
): Promise<SessionBlob | SessionBlobError | null> {
  const session = await loadCoderSession(userId, sessionId);
  const checkout = session ? checkoutOf(session) : null;
  if (!checkout) return null;

  const path = assertRepoRelativePath(options.path);
  if (options.sha) return commitBlob(userId, checkout.path, options.sha, path);

  // A worktree path is read the way every other workspace path is, so the file
  // gets the same confinement and the same size ceiling.
  const file = await readWorkspaceFile(userId, `${checkout.path}/${path}`, {
    maxBytes: MAX_PREVIEW_BYTES,
  });
  return { path, mimeType: file.mimeType, buffer: file.buffer, immutable: false };
}

/** A path's bytes as one commit holds them. */
async function commitBlob(
  userId: string,
  dir: string,
  sha: string,
  path: string,
): Promise<SessionBlob | SessionBlobError> {
  if (!COMMIT_SHA_RE.test(sha)) return { error: "Invalid sha", status: 400 };

  const fullSha = await resolveCommit(userId, dir, sha);
  if (!fullSha) return { error: "No such commit", status: 404 };

  const size = await blobSizeAt(userId, dir, fullSha, path);
  if (size === null) return { error: "This path is not in the commit", status: 404 };
  if (size > MAX_PREVIEW_BYTES) {
    return { error: "This file is too large to preview", status: 413 };
  }

  const bytes = await readBlobBytesAt(userId, dir, fullSha, path);
  if (!bytes) return { error: "Could not read this file", status: 502 };

  return {
    path,
    mimeType: resolveMimeType(path),
    buffer: new Uint8Array(bytes),
    immutable: true,
  };
}
