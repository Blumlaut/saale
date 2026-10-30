/**
 * Body schemas for the file endpoints.
 *
 * The target is not here: every route (reads and writes alike) takes it from
 * the query string, so authorization happens before a body is parsed. a caller
 * cannot make the server do work on behalf of a workspace it may not touch.
 *
 * A name is validated here rather than in the route, so a separator or a `..` is
 * a readable 400 instead of a traversal a provider has to catch later.
 */

import { z } from "zod";
import { isSafeEntryName } from "./paths";

/** A directory, relative or absolute. Empty is the workspace root. */
const path = z.string().max(4096);
const name = z
  .string()
  .min(1)
  .max(255)
  .refine(isSafeEntryName, "Name cannot contain a path separator or be '.' or '..'");

export const createDirectorySchema = z.object({ path, name });
export const createFileSchema = z.object({ path, name });
export const renameEntrySchema = z.object({ path, name });
export const deleteEntrySchema = z.object({ path });

export const writeFileSchema = z.object({
  path,
  content: z.string(),
  /** The mtime the editor loaded; a mismatch means the file was written since. */
  baseModified: z.number().optional(),
  /** Save over a file that changed, after the caller has seen it changed. */
  force: z.boolean().optional(),
});

/**
 * Chunked upload bodies.
 *
 * `size` is what the client says the whole file is, and every step checks
 * against it: the last chunk has to land exactly on it. A file that disagrees is
 * refused rather than written short.
 */
export const beginUploadSchema = z.object({
  path,
  name,
  size: z.number().int().nonnegative(),
  /** Stage only. no destination: whoever adopts the upload picks the paths. */
  inbox: z.boolean().optional(),
});

export const completeUploadSchema = z.object({
  path,
  name,
  size: z.number().int().nonnegative(),
  uploadId: z.string().min(1),
});

export const abortUploadSchema = z.object({ uploadId: z.string().min(1) });
