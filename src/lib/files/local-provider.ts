/**
 * A workspace living in the app's own uploads volume.
 *
 * This is the fallback when Open Terminal is not configured — the same directory
 * the chat upload and `show_file` routes use — so a deployment without the
 * terminal container still gets a working file browser for its users.
 *
 * The path guard alone is not enough here. It is textual, so a symlink *inside*
 * the volume pointing at `/etc` would resolve inside the root and then be
 * followed by the kernel. Where a sandbox account is protected by its own
 * permissions, this backend runs as the app's own user, so every path is
 * checked again against the *real* root after `realpath` — including the nearest
 * existing ancestor of a path that does not exist yet (an upload destination).
 */

import fs from "node:fs/promises";
import path from "node:path";
import { FileNotFoundError, FilePathEscapeError, isNotFoundError } from "./errors";
import { resolveMimeType } from "./mime";
import { dirName, isWithinRoot } from "./paths";
import { MAX_LISTING_ENTRIES } from "./config";
import type { FileProvider, RawListing } from "./provider";
import type { FileBytes, FileStat } from "./types";

export function createLocalFileProvider(options: { root: string }): FileProvider {
  const root = options.root;

  /**
   * The root's real path, created if missing. Memoized: `realpath` on every
   * request would be a syscall per call for a value that only changes if
   * someone replaces the directory under us.
   */
  let realRootPromise: Promise<string> | null = null;
  function realRoot(): Promise<string> {
    realRootPromise ??= (async () => {
      await fs.mkdir(root, { recursive: true });
      return fs.realpath(root);
    })().catch((err) => {
      // A failure must not be cached, or one bad moment bricks the workspace.
      realRootPromise = null;
      throw err;
    });
    return realRootPromise;
  }

  /**
   * Resolve `target` through the filesystem and refuse anything that lands
   * outside the real root.
   *
   * A missing target is not an error: the nearest existing ancestor is what gets
   * checked, which is exactly the case that matters for an upload into a folder
   * that is about to be created.
   */
  async function resolveReal(target: string): Promise<string> {
    const base = await realRoot();
    let probe = target;

    for (;;) {
      try {
        const real = await fs.realpath(probe);
        // The whole subtree of a legitimate symlink is fine; leaving the root
        // through one is not.
        if (!isWithinRoot(base, real)) throw new FilePathEscapeError(target);
        return probe === target ? real : path.join(real, target.slice(probe.length + 1));
      } catch (err) {
        if (!isNotFoundError(err)) throw err;
        const parent = dirName(probe);
        if (parent === probe) throw new FileNotFoundError(target);
        probe = parent;
      }
    }
  }

  const provider: FileProvider = {
    root,

    async list(dir: string): Promise<RawListing> {
      // The root is created on demand by `resolveReal`, so listing a workspace
      // that was never written to yields an empty folder. A *sub*directory that
      // is missing stays an ENOENT, which the route turns into the same 404 the
      // terminal backend produces — the two must not disagree about a folder
      // that an agent deleted.
      const realDir = await resolveReal(dir);

      const dirents = await fs.readdir(realDir, { withFileTypes: true });
      // One row past the limit is enough for the caller to see it was cut.
      const capped = dirents.slice(0, MAX_LISTING_ENTRIES + 1);
      const entries = await Promise.all(
        capped.map(async (dirent) => {
          const full = path.join(realDir, dirent.name);
          const stats = await fs.stat(full).catch(() => null);
          if (!stats) return null;
          return {
            name: dirent.name,
            kind: (stats.isDirectory() ? "directory" : "file") as "file" | "directory",
            size: stats.size,
            modified: stats.mtimeMs,
            writable: true,
          };
        }),
      );

      return { entries: entries.filter((entry) => entry !== null), writable: true };
    },

    async stat(target: string): Promise<FileStat | null> {
      try {
        const stats = await fs.stat(await resolveReal(target));
        return {
          kind: stats.isDirectory() ? "directory" : "file",
          size: stats.size,
          modified: stats.mtimeMs,
          writable: true,
        };
      } catch (err) {
        if (isNotFoundError(err)) return null;
        throw err;
      }
    },

    async read(target: string): Promise<FileBytes> {
      const real = await resolveReal(target);
      const stats = await fs.stat(real);
      if (stats.isDirectory()) throw new FileNotFoundError(target);
      const buffer = await fs.readFile(real);
      return { buffer, mimeType: resolveMimeType(path.basename(real)) };
    },

    async write(target: string, data: Buffer): Promise<void> {
      // The parent may be a folder the caller just created; create it here too
      // so a write into a fresh tree is not a special case.
      await fs.mkdir(dirName(target), { recursive: true });
      await fs.writeFile(await resolveReal(target), data);
    },

    async createDirectory(target: string): Promise<void> {
      await fs.mkdir(await resolveReal(target), { recursive: true });
    },

    async rename(from: string, to: string): Promise<void> {
      await fs.rename(await resolveReal(from), await resolveReal(to));
    },

    async remove(target: string): Promise<void> {
      const real = await resolveReal(target);
      // Deleting something already gone is the outcome the caller wanted.
      await fs.rm(real, { recursive: true, force: true });
    },
  };

  return provider;
}
