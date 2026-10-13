/**
 * Body schemas for the file endpoints.
 *
 * The target is not here: every route (reads and writes alike) takes it from
 * the query string, so authorization happens before a body is parsed — a caller
 * cannot make the server do work on behalf of a workspace it may not touch.
 *
 * A name is validated here rather than in the route, so a separator or a `..` is
 * a readable 400 instead of a traversal a provider has to catch later.
 */

import { z } from "zod";
import { isSafeEntryName } from "./paths";

const path = z.string().min(1).max(4096);
const name = z
  .string()
  .min(1)
  .max(255)
  .refine(isSafeEntryName, "Name cannot contain a path separator or be '.' or '..'");

export const createDirectorySchema = z.object({ path, name });
export const renameEntrySchema = z.object({ path, name });
export const deleteEntrySchema = z.object({ path });
