/**
 * Chunked uploads into a workspace.
 *
 * A file arrives in pieces, is appended to `<root>/.tmp/upload-<id>`, and is
 * renamed onto its destination once the last piece is in. Only one chunk is
 * ever in memory, so a file's ceiling is the volume instead of the heap, and a
 * dropped connection costs the chunk in flight rather than the whole upload.
 *
 * No session is stored. The id names the staged file, and each request checks
 * that file's size against the offset it carries, so any instance can serve any
 * chunk and a restart costs nothing. Staging lives in the workspace's scratch
 * directory, which the sandbox service empties.
 */

import { randomUUID } from "node:crypto";
import { MAX_UPLOAD_BYTES_PER_FILE, MAX_UPLOAD_CHUNK_BYTES } from "./config";
import { FileConflictError, FileLimitError, FileNotFoundError, FileUploadError } from "./errors";
import { isSafeEntryName, requireWithinRoot } from "./paths";
import { WORKSPACE_TMP_DIR } from "@/lib/sandbox/workspace";
import { formatFileSize } from "@/lib/utils";
import type { OpenedFileTarget } from "./targets";

/** The staged name of an upload. Random, so one uploader cannot name another's. */
const UPLOAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Where a chunked upload is assembled until it is finished. */
export function stagedUploadPath(root: string, uploadId: string): string {
  if (!UPLOAD_ID.test(uploadId)) throw new FileNotFoundError(uploadId);
  return requireWithinRoot(root, `${root}/${WORKSPACE_TMP_DIR}/upload-${uploadId}`);
}

function stagingDir(root: string): string {
  return requireWithinRoot(root, `${root}/${WORKSPACE_TMP_DIR}`);
}

/** A file on its way in: where it lands, and how many bytes it has. */
export interface UploadDestination {
  /** Directory the file lands in, absolute. */
  dir: string;
  name: string;
  size: number;
}

function assertSize(size: number): void {
  if (size <= 0) throw new FileLimitError("File is empty");
  if (size > MAX_UPLOAD_BYTES_PER_FILE) {
    throw new FileLimitError(`File is larger than ${formatFileSize(MAX_UPLOAD_BYTES_PER_FILE)}`);
  }
}

function destinationPath(opened: OpenedFileTarget, spec: UploadDestination): string {
  if (!isSafeEntryName(spec.name)) throw new FileUploadError(`Not a valid file name: ${spec.name}`);
  return requireWithinRoot(opened.info.root, `${spec.dir === "/" ? "" : spec.dir}/${spec.name}`);
}

/** Refuse a destination that is taken unless the caller asked to replace it. */
async function assertFree(
  opened: OpenedFileTarget,
  destination: string,
  name: string,
  overwrite: boolean,
): Promise<void> {
  if (overwrite) return;
  if (await opened.provider.stat(destination)) throw new FileConflictError([name]);
}

/**
 * Start an upload and hand back the id its chunks are named with.
 *
 * `inbox` skips the destination: the caller stages the file and hands the id to
 * whatever will adopt it (a chat message picks its own paths).
 */
export async function beginUpload(
  opened: OpenedFileTarget,
  spec: UploadDestination,
  options: { overwrite: boolean; inbox: boolean },
): Promise<{ uploadId: string }> {
  assertSize(spec.size);
  if (!options.inbox) {
    const destination = destinationPath(opened, spec);
    await assertFree(opened, destination, spec.name, options.overwrite);
  }

  await opened.provider.createDirectory(stagingDir(opened.info.root));
  return { uploadId: randomUUID() };
}

/**
 * Append one chunk.
 *
 * `index` is checked against the bytes already staged, so a chunk that arrives
 * out of order is refused instead of quietly producing a corrupt file.
 */
export async function appendUploadChunk(
  opened: OpenedFileTarget,
  uploadId: string,
  index: number,
  chunk: Buffer,
): Promise<{ received: number }> {
  if (chunk.length === 0) throw new FileUploadError("Empty chunk");
  if (chunk.length > MAX_UPLOAD_CHUNK_BYTES) {
    throw new FileLimitError(`A chunk may be at most ${formatFileSize(MAX_UPLOAD_CHUNK_BYTES)}`);
  }

  const staged = stagedUploadPath(opened.info.root, uploadId);
  const existing = await opened.provider.stat(staged);
  const offset = index * MAX_UPLOAD_CHUNK_BYTES;
  if ((existing?.size ?? 0) !== offset) {
    throw new FileUploadError(`Chunk ${index} does not continue this upload`);
  }
  if (offset + chunk.length > MAX_UPLOAD_BYTES_PER_FILE) {
    throw new FileLimitError(`File is larger than ${formatFileSize(MAX_UPLOAD_BYTES_PER_FILE)}`);
  }

  await opened.provider.append(staged, chunk);
  return { received: offset + chunk.length };
}

/**
 * Move the assembled file onto its destination.
 *
 * The rename is what makes an upload all-or-nothing: until it happens the
 * destination either does not exist or still holds the file it held before.
 */
export async function finishUpload(
  opened: OpenedFileTarget,
  uploadId: string,
  spec: UploadDestination,
  overwrite: boolean,
): Promise<{ path: string }> {
  const staged = stagedUploadPath(opened.info.root, uploadId);
  const assembled = await opened.provider.stat(staged);
  if (!assembled || assembled.kind !== "file") throw new FileNotFoundError(uploadId);
  if (assembled.size !== spec.size) {
    throw new FileUploadError(`Upload incomplete: ${assembled.size} of ${spec.size} bytes`);
  }

  const destination = destinationPath(opened, spec);
  await assertFree(opened, destination, spec.name, overwrite);
  await opened.provider.rename(staged, destination);
  return { path: destination };
}

/** Drop an upload's bytes. Called when a client gives up, and safe to repeat. */
export async function abortUpload(opened: OpenedFileTarget, uploadId: string): Promise<void> {
  await opened.provider.remove(stagedUploadPath(opened.info.root, uploadId));
}
