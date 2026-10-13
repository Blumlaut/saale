/**
 * A workspace living inside the Open Terminal container.
 *
 * The app has no disk access to these files — the volume is mounted only into
 * that container, and each workspace is a Linux account whose home is `2770`, so
 * the kernel is the boundary. Every call therefore names the identity it runs
 * as: a council passes its sandbox key, a user passes their own id.
 *
 * Two Open Terminal quirks are normalised here:
 *
 * - `modified` comes back as epoch *seconds* with sub-second precision, while
 *   everything else in the app counts milliseconds.
 * - `readFileBinary` reports `application/octet-stream` for anything it does not
 *   recognise as an image or plain text, so the extension decides the type.
 */

import * as terminal from "@/lib/terminal/client";
import { baseName, dirName } from "./paths";
import { isNotFoundError } from "./errors";
import { resolveMimeType } from "./mime";
import { statViaParent, type FileProvider, type RawListing } from "./provider";
import type { FileBytes, FileStat } from "./types";

/** Open Terminal answers in seconds; the app reads milliseconds. */
function toEpochMs(seconds: number): number {
  return Math.round(seconds * 1000);
}

export function createTerminalFileProvider(options: {
  /** The workspace identity — a council's sandbox key, or a user's id. */
  identity: string;
  root: string;
  sessionId?: string;
}): FileProvider {
  const { identity, root, sessionId } = options;
  const user = sessionId ? { userId: identity, sessionId } : { userId: identity };

  const provider: FileProvider = {
    root,

    async list(dir: string): Promise<RawListing> {
      const result = await terminal.listDirectory(dir, user);
      return {
        writable: result.writable ?? true,
        entries: result.entries.map((entry) => ({
          name: entry.name,
          kind: entry.type === "directory" ? "directory" : "file",
          size: entry.size,
          modified: toEpochMs(entry.modified),
          writable: entry.writable ?? true,
        })),
      };
    },

    stat(path: string): Promise<FileStat | null> {
      return statViaParent(provider, path);
    },

    async read(path: string): Promise<FileBytes> {
      const result = await terminal.readFileBinary(path, user);
      return {
        buffer: result.buffer,
        mimeType: resolveMimeType(baseName(path), result.mimeType),
      };
    },

    async write(path: string, data: Buffer): Promise<void> {
      // The container's upload endpoint takes a file name and a target
      // directory, not a path — it is how binary content reaches the volume.
      await terminal.uploadFile(baseName(path), data, { directory: dirName(path), ...user });
    },

    async createDirectory(path: string): Promise<void> {
      await terminal.createDirectory(path, user);
    },

    async rename(from: string, to: string): Promise<void> {
      await terminal.moveFile(from, to, user);
    },

    async remove(path: string): Promise<void> {
      try {
        await terminal.deleteFile(path, user);
      } catch (err) {
        // Deleting something already gone is the outcome the caller wanted.
        if (!isNotFoundError(err)) throw err;
      }
    },
  };

  return provider;
}
