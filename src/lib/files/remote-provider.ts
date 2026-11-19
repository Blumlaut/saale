/**
 * A workspace that lives on someone else's machine, reached over SFTP.
 *
 * The file routes, the browser and the zip builder know nothing about this: a
 * remote server answers the same provider questions as the user's own volume,
 * so connecting to one points the browser at a target.
 *
 * Paths are POSIX either way, and the root is the account's home directory, so
 * the path guard in `paths.ts` confines a remote browse the same way it
 * confines a local one. A symlink inside that home still points where it
 * points, and reading through it is the account's own business.
 */

import type { Readable } from "node:stream";
import type { FileEntryWithStats, SFTPWrapper, Stats } from "ssh2";
import { FileNotFoundError } from "./errors";
import { resolveMimeType } from "./mime";
import { baseName, dirName, isWithinRoot } from "./paths";
import { MAX_LISTING_ENTRIES } from "./config";
import type { FileProvider, RawListing } from "./provider";
import type { FileBytes, FileKind, FileStat } from "./types";

/** An SFTP session, and the connection that has to be released with it. */
export interface SftpSession {
  sftp: SFTPWrapper;
  release(): void;
}

export interface RemoteFileProviderOptions {
  /** The account's home directory: everything below it is browsable. */
  root: string;
  /** Opens a session per operation; the provider releases it. */
  openSession: () => Promise<SftpSession>;
}

function kindOf(stats: Stats): FileKind {
  return stats.isDirectory() ? "directory" : "file";
}

function sftpReaddir(sftp: SFTPWrapper, dir: string): Promise<FileEntryWithStats[]> {
  return new Promise((resolve, reject) => {
    sftp.readdir(dir, (err, entries) => {
      if (err) reject(err);
      else resolve(entries);
    });
  });
}

function sftpStat(sftp: SFTPWrapper, path: string): Promise<Stats> {
  return new Promise((resolve, reject) => {
    sftp.stat(path, (err, stats) => {
      if (err) reject(err);
      else resolve(stats);
    });
  });
}

function sftpReadFile(sftp: SFTPWrapper, path: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    sftp.readFile(path, (err, data) => {
      if (err) reject(err);
      else resolve(data);
    });
  });
}

function sftpRename(sftp: SFTPWrapper, from: string, to: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.rename(from, to, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function sftpMkdir(sftp: SFTPWrapper, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.mkdir(path, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function sftpUnlink(sftp: SFTPWrapper, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.unlink(path, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function sftpRmdir(sftp: SFTPWrapper, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.rmdir(path, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

/** Put a buffer into a remote file, replacing it or appending to it. */
async function sftpPut(
  sftp: SFTPWrapper,
  path: string,
  data: Buffer,
  flags: "w" | "a",
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const stream = sftp.createWriteStream(path, { flags });
    stream.on("error", reject);
    stream.on("close", () => resolve());
    stream.end(data);
  });
}

/** Walk a remote directory, deleting files first so each level is empty. */
async function removeTree(sftp: SFTPWrapper, path: string, stats: Stats): Promise<void> {
  if (!stats.isDirectory()) {
    await sftpUnlink(sftp, path);
    return;
  }
  const entries = await sftpReaddir(sftp, path);
  for (const entry of entries) {
    await removeTree(sftp, `${path}/${entry.filename}`, entry.attrs);
  }
  await sftpRmdir(sftp, path);
}

/**
 * A remote workspace.
 *
 * Nothing is cached: a connection is opened per operation, so a file always
 * reads what the machine holds now and a browser left open costs nothing.
 */
export function createRemoteFileProvider(options: RemoteFileProviderOptions): FileProvider {
  const { root, openSession } = options;

  /** Run one operation on a session of its own, and let go of it after. */
  async function withSftp<T>(operation: (sftp: SFTPWrapper) => Promise<T>): Promise<T> {
    const session = await openSession();
    try {
      return await operation(session.sftp);
    } finally {
      session.release();
    }
  }

  /** A path this provider is about to touch, checked against the root again. */
  function confined(path: string): string {
    if (!isWithinRoot(root, path)) throw new FileNotFoundError(path);
    return path;
  }

  /** `mkdir -p` over SFTP, which only makes one directory at a time. */
  async function createDirectory(sftp: SFTPWrapper, path: string): Promise<void> {
    const segments = path.split("/").filter(Boolean);
    let current = path.startsWith("/") ? "" : ".";

    for (const segment of segments) {
      current = `${current}/${segment}`;
      try {
        await sftpMkdir(sftp, current);
      } catch (err) {
        // A directory that is already there is the desired end state.
        const existing = await sftpStat(sftp, current).catch(() => null);
        if (!existing?.isDirectory()) throw err;
      }
    }
  }

  const provider: FileProvider = {
    root,

    async list(dir: string): Promise<RawListing> {
      const path = confined(dir);
      return withSftp(async (sftp) => {
        const entries = await sftpReaddir(sftp, path);
        return {
          entries: entries
            .filter((entry) => entry.filename !== "." && entry.filename !== "..")
            // One row past the limit tells the caller the folder was cut.
            .slice(0, MAX_LISTING_ENTRIES + 1)
            .map((entry) => ({
              name: entry.filename,
              kind: kindOf(entry.attrs),
              size: entry.attrs.size,
              modified: entry.attrs.mtime * 1000,
              writable: true,
            })),
          writable: true,
        };
      });
    },

    async stat(target: string): Promise<FileStat | null> {
      const path = confined(target);
      return withSftp(async (sftp) => {
        try {
          const stats = await sftpStat(sftp, path);
          return {
            kind: kindOf(stats),
            size: stats.size,
            modified: stats.mtime * 1000,
            writable: true,
          };
        } catch (err) {
          // A missing path answers this question with null.
          if (isMissing(err)) return null;
          throw err;
        }
      });
    },

    async read(target: string): Promise<FileBytes> {
      const path = confined(target);
      return withSftp(async (sftp) => {
        const stats = await sftpStat(sftp, path);
        if (stats.isDirectory()) throw new FileNotFoundError(path);
        const buffer = await sftpReadFile(sftp, path);
        // A copy of the bytes, so the response body owns an ArrayBuffer.
        return { buffer: Uint8Array.from(buffer), mimeType: resolveMimeType(baseName(path)) };
      });
    },

    async openReadStream(target: string): Promise<ReadableStream<Uint8Array>> {
      const path = confined(target);
      const session = await openSession();

      try {
        const stats = await sftpStat(session.sftp, path);
        if (stats.isDirectory()) throw new FileNotFoundError(path);
        // The stream outlives this call, so it releases the session itself.
        return streamedBytes(session.sftp.createReadStream(path), session, path);
      } catch (err) {
        session.release();
        throw err;
      }
    },

    async write(target: string, data: Buffer): Promise<void> {
      const path = confined(target);
      await withSftp((sftp) => sftpPut(sftp, path, data, "w"));
    },

    async append(target: string, data: Buffer): Promise<void> {
      const path = confined(target);
      await withSftp((sftp) => sftpPut(sftp, path, data, "a"));
    },

    async copy(from: string, to: string): Promise<void> {
      const source = confined(from);
      const destination = confined(to);
      const data = await withSftp((sftp) => sftpReadFile(sftp, source));
      await withSftp((sftp) => sftpPut(sftp, destination, data, "w"));
    },

    async createDirectory(target: string): Promise<void> {
      const path = confined(target);
      await withSftp((sftp) => createDirectory(sftp, path));
    },

    async rename(from: string, to: string): Promise<void> {
      const source = confined(from);
      const destination = confined(to);
      await withSftp(async (sftp) => {
        await createDirectory(sftp, dirName(destination));
        await sftpRename(sftp, source, destination);
      });
    },

    async remove(target: string): Promise<void> {
      const path = confined(target);
      await withSftp(async (sftp) => {
        const stats = await sftpStat(sftp, path).catch((err: unknown) => {
          if (isMissing(err)) return null;
          throw err;
        });
        // Deleting something already gone is the outcome the caller wanted.
        if (!stats) return;
        await removeTree(sftp, path, stats);
      });
    },
  };

  return provider;
}

/**
 * A remote read as a web stream, holding the consumer's pace.
 *
 * A download is a whole file crossing this process, so the read waits while the
 * response has no room for more bytes. The session is released however the stream ends.
 */
function streamedBytes(
  stream: Readable,
  session: SftpSession,
  path: string,
): ReadableStream<Uint8Array> {
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    session.release();
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      stream.on("data", (chunk: Buffer) => {
        controller.enqueue(new Uint8Array(chunk));
        if (controller.desiredSize !== null && controller.desiredSize <= 0) stream.pause();
      });
      stream.on("error", (err: unknown) => {
        console.error(`Failed to read ${path} off the machine:`, err);
        controller.error(err);
        release();
      });
      stream.on("end", () => {
        try {
          controller.close();
        } catch (err) {
          console.error(`Failed to close the stream for ${path}:`, err);
        }
        release();
      });
    },
    pull() {
      stream.resume();
    },
    cancel() {
      stream.destroy();
      release();
    },
  });
}

/**
 * Whether SFTP said the path is not there.
 *
 * The protocol answers with a status the client turns into a message, and a
 * machine whose profile prints a banner can fail before it says anything, so
 * both the code and the wording are checked.
 */
function isMissing(err: unknown): boolean {
  if ((err as { code?: unknown }).code === 2) return true;
  const message = err instanceof Error ? err.message : String(err);
  return /no such file|not found/i.test(message);
}
