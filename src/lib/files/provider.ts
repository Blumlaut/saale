/**
 * The workspace abstraction the file browser is built on.
 *
 * A provider answers the same questions for every backend. list, stat, read,
 * write, create, rename, remove. so the routes, the zip builder and the UI
 * never learn whether the bytes live in the terminal container or in the app's
 * own uploads volume. Adding "a user's own files" later is a third
 * implementation, not a second browser.
 *
 * Providers are handed *absolute* paths and never see a raw client string: the
 * routes resolve and validate with `paths.ts` first, so every provider method
 * receives a path that is already known to be inside its root.
 */

import { baseName, dirName } from "./paths";
import { isNotFoundError } from "./errors";
import type { FileBytes, FileEntry, FileKind, FileStat } from "./types";

/** One row as a provider reports it, before listing limits and sorting. */
export interface RawEntry {
  name: string;
  kind: FileKind;
  size: number;
  /** Epoch milliseconds. */
  modified: number;
  writable: boolean;
}

export interface RawListing {
  entries: RawEntry[];
  /** Whether the backend reports the directory itself as writable. */
  writable: boolean;
}

export interface FileProvider {
  /** Absolute path of the workspace root. */
  readonly root: string;

  list(dir: string): Promise<RawListing>;

  /** `null` when the path does not exist. */
  stat(path: string): Promise<FileStat | null>;

  read(path: string): Promise<FileBytes>;

  write(path: string, data: Buffer): Promise<void>;

  createDirectory(path: string): Promise<void>;

  rename(from: string, to: string): Promise<void>;

  /** Removes a file, or a directory and everything in it. */
  remove(path: string): Promise<void>;
}

/** Natural order, so `file10` sorts after `file2` rather than before it. */
const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

/** A dotfile: hidden from listings unless asked for. */
export function isDotfile(name: string): boolean {
  return name.startsWith(".") && name !== "." && name !== "..";
}

/**
 * Turn a provider's rows into listing entries: absolute paths, dotfiles
 * filtered, directories first, capped.
 *
 * The cap is applied after sorting so the rows that survive are the ones a
 * reader expects to see, and the caller is told the listing was cut rather than
 * being handed a silently shortened folder.
 */
export function toListing(
  listing: RawListing,
  dir: string,
  options: { hideDotfiles: boolean; limit: number },
): { entries: FileEntry[]; truncated: boolean } {
  const visible = options.hideDotfiles
    ? listing.entries.filter((entry) => !isDotfile(entry.name))
    : listing.entries;

  const sorted = [...visible].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
    return collator.compare(a.name, b.name);
  });

  const truncated = sorted.length > options.limit;
  const entries = (truncated ? sorted.slice(0, options.limit) : sorted).map((entry) => ({
    name: entry.name,
    path: `${dir === "/" ? "" : dir}/${entry.name}`,
    kind: entry.kind,
    size: entry.size,
    modified: entry.modified,
    writable: entry.writable,
  }));

  return { entries, truncated };
}

/**
 * Look one path up through its parent directory.
 *
 * The terminal API has no stat, and this avoids inventing one: a directory
 * listing already carries everything a stat needs, and existence is the only
 * question the routes ask of it (is this name taken?).
 */
export async function statViaParent(
  provider: FileProvider,
  path: string,
): Promise<FileStat | null> {
  const parent = dirName(path);
  const name = baseName(path);
  try {
    const listing = await provider.list(parent);
    const entry = listing.entries.find((candidate) => candidate.name === name);
    if (!entry) return null;
    return {
      kind: entry.kind,
      size: entry.size,
      modified: entry.modified,
      writable: entry.writable,
    };
  } catch (err) {
    if (isNotFoundError(err)) return null;
    throw err;
  }
}

/** Whether a path exists, using {@link statViaParent} on backends without stat. */
export async function pathExists(provider: FileProvider, path: string): Promise<boolean> {
  return (await provider.stat(path)) !== null;
}
