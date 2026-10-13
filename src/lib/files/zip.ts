/**
 * Zip downloads for a selection of files and folders.
 *
 * Two passes, deliberately. The selection is walked and measured first, so a
 * selection that exceeds a ceiling is refused with a status and a sentence
 * instead of a download that stops halfway — a truncated archive is worse than
 * a refusal, because it looks like it worked. Only then are bytes streamed.
 *
 * Entries are read lazily, one at a time, as the archive is written:
 * `addReadStreamLazy` asks for the next file only once the previous one is on
 * the wire, which keeps memory flat no matter how large the selection is. A file
 * that changes size between the two passes fails the entry, which destroys the
 * response rather than shipping a corrupt archive.
 */

import { Readable } from "node:stream";
import { ZipFile } from "yazl";
import { MAX_DOWNLOAD_BYTES, MAX_ZIP_BYTES, MAX_ZIP_ENTRIES } from "./config";
import { FileLimitError, FileNotFoundError, FilePathEscapeError } from "./errors";
import { formatFileSize } from "@/lib/utils";
import { baseName, relativeToRoot } from "./paths";
import { isDotfile, type FileProvider } from "./provider";

/** Paths the caller selected — files, folders, or a mix of both. */
export type ZipSelection = string;

export interface ZipPlanEntry {
  /** Name inside the archive, relative to the folder being browsed. */
  name: string;
  path: string;
  size: number;
  modified: number;
}

export interface ZipPlan {
  entries: ZipPlanEntry[];
  /** Folders that would otherwise leave no trace in the archive. */
  emptyDirectories: { name: string; modified: number }[];
  totalBytes: number;
  fileName: string;
}

/**
 * Walk a selection and decide what the archive will contain.
 *
 * Every entry is named relative to `dir` — the folder being browsed — so a
 * selection spanning subfolders keeps its shape and two files of the same name
 * in different folders cannot collide. A selection that is not under `dir` is
 * refused: an entry name would otherwise have to climb out with `..`.
 */
export async function planZip(
  provider: FileProvider,
  dir: string,
  selections: ZipSelection[],
  options: { includeDotfiles: boolean },
): Promise<ZipPlan> {
  const entries: ZipPlanEntry[] = [];
  const emptyDirectories: ZipPlan["emptyDirectories"] = [];
  const seen = new Set<string>();
  let totalBytes = 0;

  async function add(path: string, name: string): Promise<void> {
    if (seen.has(path)) return;
    seen.add(path);

    const stat = await provider.stat(path);
    if (!stat) throw new FileNotFoundError(path);

    if (stat.kind === "file") {
      totalBytes += stat.size;
      if (stat.size > MAX_DOWNLOAD_BYTES) {
        throw new FileLimitError(
          `${baseName(path)} is larger than ${formatFileSize(MAX_DOWNLOAD_BYTES)} and cannot be zipped.`,
        );
      }
      if (entries.length >= MAX_ZIP_ENTRIES) {
        throw new FileLimitError(
          `That selection has more than ${MAX_ZIP_ENTRIES} files. Pick fewer, or a smaller folder.`,
        );
      }
      if (totalBytes > MAX_ZIP_BYTES) {
        throw new FileLimitError(
          `That selection is larger than ${formatFileSize(MAX_ZIP_BYTES)}. Pick fewer, or a smaller folder.`,
        );
      }
      entries.push({ name, path, size: stat.size, modified: stat.modified });
      return;
    }

    const listing = await provider.list(path);
    const children = options.includeDotfiles
      ? listing.entries
      : listing.entries.filter((child) => !isDotfile(child.name));

    if (children.length === 0) {
      emptyDirectories.push({ name, modified: stat.modified });
      return;
    }

    for (const child of children) {
      await add(`${path}/${child.name}`, `${name}/${child.name}`);
    }
  }

  for (const selection of selections) {
    const name = relativeToRoot(dir, selection);
    if (name === null || name === "") throw new FilePathEscapeError(selection);
    await add(selection, name);
  }

  // One folder selected downloads as that folder; a mixed selection is "files".
  const [first] = selections;
  const single = selections.length === 1 && first ? await provider.stat(first) : null;
  const fileName = single?.kind === "directory" && first ? `${baseName(first)}.zip` : "files.zip";

  return { entries, emptyDirectories, totalBytes, fileName };
}

/** Stream a plan as an archive body. */
export function streamZip(provider: FileProvider, plan: ZipPlan): ReadableStream<Uint8Array> {
  const zip = new ZipFile();
  const output = zip.outputStream as Readable;

  zip.on("error", (err) => {
    // Headers are already sent by the time an entry can fail, so the only
    // honest signal left is a broken stream.
    console.error("Zip archive failed mid-download:", err);
    output.destroy(err instanceof Error ? err : new Error(String(err)));
  });

  for (const directory of plan.emptyDirectories) {
    zip.addEmptyDirectory(directory.name, { mtime: new Date(directory.modified) });
  }

  for (const entry of plan.entries) {
    zip.addReadStreamLazy(
      entry.name,
      { size: entry.size, mtime: new Date(entry.modified) },
      (cb) => {
        provider.read(entry.path).then(
          (file) => cb(null, Readable.from([file.buffer])),
          (err) => cb(err instanceof Error ? err : new Error(String(err)), undefined as never),
        );
      },
    );
  }

  zip.end();
  return Readable.toWeb(output) as ReadableStream<Uint8Array>;
}
