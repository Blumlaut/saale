import { inflateRawSync } from "node:zlib";
import { resolveMimeType } from "@/lib/files/mime";
import type { FileProvider, RawListing } from "@/lib/files/provider";
import type { FileBytes, FileStat } from "@/lib/files/types";

/**
 * An in-memory workspace for tests.
 *
 * `null` marks a directory; any other value is a file's content. Paths are
 * absolute, as every provider receives them.
 */
export type FakeTree = Record<string, string | null>;

/** Every entry looks written at the same moment, so mtimes never flake a test. */
const FIXED_MTIME = 1_700_000_000_000;

export function createFakeProvider(tree: FakeTree, root = "/workspace"): FileProvider {
  const files = new Map<string, string | null>(Object.entries(tree));
  // The root always exists, even when a test names no entries under it.
  files.set(root, files.get(root) ?? null);

  function childrenOf(dir: string): string[] {
    const prefix = dir === "/" ? "/" : `${dir}/`;
    return [...files.keys()].filter((path) => {
      if (path === dir || !path.startsWith(prefix)) return false;
      return !path.slice(prefix.length).includes("/");
    });
  }

  return {
    root,

    async list(dir: string): Promise<RawListing> {
      return {
        writable: true,
        entries: childrenOf(dir).map((path) => {
          const value = files.get(path) ?? null;
          return {
            name: path.slice(path.lastIndexOf("/") + 1),
            kind: value === null ? ("directory" as const) : ("file" as const),
            size: value === null ? 0 : Buffer.byteLength(value),
            modified: FIXED_MTIME,
            writable: true,
          };
        }),
      };
    },

    async stat(path: string): Promise<FileStat | null> {
      if (!files.has(path)) return null;
      const value = files.get(path) ?? null;
      return {
        kind: value === null ? "directory" : "file",
        size: value === null ? 0 : Buffer.byteLength(value),
        modified: FIXED_MTIME,
        writable: true,
      };
    },

    async read(path: string): Promise<FileBytes> {
      const value = files.get(path);
      if (value === undefined || value === null) throw new Error(`not a file: ${path}`);
      const buffer = Buffer.from(value);
      // The same type resolution the real providers do, so a route test sees the
      // media type a browser would.
      return {
        buffer: new Uint8Array(buffer),
        mimeType: resolveMimeType(path.slice(path.lastIndexOf("/") + 1)),
      };
    },

    async write(path: string, data: Buffer): Promise<void> {
      files.set(path, data.toString("utf8"));
    },

    async createDirectory(path: string): Promise<void> {
      files.set(path, null);
    },

    async rename(from: string, to: string): Promise<void> {
      const value = files.get(from);
      if (value === undefined) throw new Error(`not found: ${from}`);
      files.delete(from);
      for (const path of [...files.keys()]) {
        if (path.startsWith(`${from}/`)) {
          files.set(`${to}${path.slice(from.length)}`, files.get(path) ?? null);
          files.delete(path);
        }
      }
      files.set(to, value);
    },

    async remove(path: string): Promise<void> {
      files.delete(path);
      for (const candidate of [...files.keys()]) {
        if (candidate.startsWith(`${path}/`)) files.delete(candidate);
      }
    },
  };
}

export interface ZipEntryRead {
  name: string;
  /** Uncompressed size from the central directory. */
  size: number;
  content: Buffer;
}

/**
 * Read a zip's entries for real.
 *
 * Parses the central directory and inflates deflated entries, so a test asserts
 * the bytes a client would download rather than trusting the library that wrote
 * them.
 */
export function readZipEntries(buffer: Buffer): ZipEntryRead[] {
  const eocd = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error("Not a zip: no end-of-central-directory record");

  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries: ZipEntryRead[] = [];

  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error(`Bad central directory signature at ${offset}`);
    }
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const size = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");

    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);
    const content = method === 8 ? inflateRawSync(raw) : Buffer.from(raw);

    entries.push({ name, size, content });
    offset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}
