/**
 * A workspace living in the app's own uploads volume.
 *
 * This is the fallback when Open Terminal is not configured. the same directory
 * the chat upload and `show_file` routes use. so a deployment without the
 * terminal container still gets a working file browser for its users.
 *
 * The path guard alone is not enough here. It is textual, so a symlink *inside*
 * the volume pointing at `/etc` would resolve inside the root and then be
 * followed by the kernel. Where a sandbox account is protected by its own
 * permissions, this backend runs as the app's own user, so every path is
 * checked again against the *real* root after `realpath`. including the nearest
 * existing ancestor of a path that does not exist yet (an upload destination).
 *
 * The reads below carry `turbopackIgnore` comments to opt out of build-time
 * filesystem tracing. The root is only known at runtime, so the tracer cannot
 * scope the paths and would otherwise copy the whole project into the server
 * output. Writes need no opt-out: the tracer only widens the output for reads.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { FileNotFoundError, FilePathEscapeError, isNotFoundError } from "./errors";
import { resolveMimeType } from "./mime";
import { dirName, isWithinRoot } from "./paths";
import { MAX_LISTING_ENTRIES } from "./config";
import type { FileProvider, RawListing } from "./provider";
import type { FileBytes, FileStat } from "./types";

export function createLocalFileProvider(options: {
  root: string;
  /** Owner given to everything this provider creates (a sandbox container's account). */
  owner?: { uid: number; gid: number } | null;
}): FileProvider {
  const root = options.root;
  const owner = options.owner ?? null;

  /** Hand a path this provider created to the container's account. */
  async function own(target: string): Promise<void> {
    if (!owner) return;
    try {
      await fs.chown(/* turbopackIgnore: true */ target, owner.uid, owner.gid);
    } catch (err) {
      console.error(`Failed to hand ${target} to ${owner.uid}:${owner.gid}:`, err);
    }
  }

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

  /**
   * `mkdir -p`, handing over every directory that had to be created.
   *
   * The owner of a file is not enough: a directory the app created as root and
   * left root-owned stops the container's account from writing inside it at
   * all, so the whole chain it creates belongs to that account.
   */
  async function mkdirOwned(target: string): Promise<void> {
    const created: string[] = [];
    let probe = target;
    for (;;) {
      try {
        await fs.stat(/* turbopackIgnore: true */ probe);
        break;
      } catch (err) {
        if (!isNotFoundError(err)) throw err;
        created.push(probe);
      }
      const parent = dirName(probe);
      if (parent === probe) break;
      probe = parent;
    }

    await fs.mkdir(/* turbopackIgnore: true */ target, { recursive: true });
    for (const dir of created.reverse()) await own(dir);
  }

  const provider: FileProvider = {
    root,

    async list(dir: string): Promise<RawListing> {
      // The root is created on demand by `resolveReal`, so listing a workspace
      // that was never written to yields an empty folder. A *sub*directory that
      // is missing stays an ENOENT, which the route turns into the same 404 the
      // terminal backend produces. the two must not disagree about a folder
      // that an agent deleted.
      const realDir = await resolveReal(dir);

      const dirents = await fs.readdir(/* turbopackIgnore: true */ realDir, {
        withFileTypes: true,
      });
      // One row past the limit is enough for the caller to see it was cut.
      const capped = dirents.slice(0, MAX_LISTING_ENTRIES + 1);
      const entries = await Promise.all(
        capped.map(async (dirent) => {
          const full = path.join(/* turbopackIgnore: true */ realDir, dirent.name);
          // A name that vanished between the read and the stat is simply gone;
          // anything else (a permission error, a dead mount) still hides the
          // row, so it is logged rather than passed off as a missing file.
          const stats = await fs.stat(/* turbopackIgnore: true */ full).catch((err) => {
            if (!isNotFoundError(err)) {
              console.error(`Failed to stat ${full} while listing a directory:`, err);
            }
            return null;
          });
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
        const stats = await fs.stat(/* turbopackIgnore: true */ await resolveReal(target));
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
      const stats = await fs.stat(/* turbopackIgnore: true */ real);
      if (stats.isDirectory()) throw new FileNotFoundError(target);
      const buffer = await fs.readFile(/* turbopackIgnore: true */ real);
      return { buffer, mimeType: resolveMimeType(path.basename(real)) };
    },

    async write(target: string, data: Buffer): Promise<void> {
      // The parent may be a folder the caller just created; create it here too
      // so a write into a fresh tree is not a special case.
      await mkdirOwned(dirName(target));
      const real = await resolveReal(target);
      await fs.writeFile(real, data);
      await own(real);
    },

    async append(target: string, data: Buffer): Promise<void> {
      await mkdirOwned(dirName(target));
      const real = await resolveReal(target);
      await fs.appendFile(real, data);
      await own(real);
    },

    async copy(from: string, to: string): Promise<void> {
      await mkdirOwned(dirName(to));
      const source = await resolveReal(from);
      const destination = await resolveReal(to);
      await fs.copyFile(source, destination);
      await own(destination);
    },

    async createDirectory(target: string): Promise<void> {
      await mkdirOwned(await resolveReal(target));
    },

    async rename(from: string, to: string): Promise<void> {
      await mkdirOwned(dirName(to));
      await fs.rename(await resolveReal(from), await resolveReal(to));
      await own(await resolveReal(to));
    },

    async remove(target: string): Promise<void> {
      const real = await resolveReal(target);
      // Deleting something already gone is the outcome the caller wanted.
      await fs.rm(real, { recursive: true, force: true });
    },
  };

  return provider;
}
