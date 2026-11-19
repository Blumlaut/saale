import { Readable, Writable } from "node:stream";
import type { FileEntryWithStats, SFTPWrapper, Stats } from "ssh2";
import { describe, expect, it } from "vitest";
import { FileNotFoundError } from "@/lib/files/errors";
import { createRemoteFileProvider, type SftpSession } from "@/lib/files/remote-provider";

/**
 * An SFTP server in a map.
 *
 * Only what the provider calls is here: a machine is not something a unit test
 * can reach, and what the provider does with a session, its paths and its
 * errors is the part worth pinning down.
 */
class FakeSftp {
  readonly nodes = new Map<string, { directory: boolean; data?: Buffer }>();
  released = 0;

  constructor(root: string) {
    for (const path of [root, "/home"]) this.nodes.set(path, { directory: true });
  }

  stat(path: string, cb: (err: Error | null, stats?: Stats) => void): void {
    const node = this.nodes.get(path);
    if (!node) return cb(missing(path));
    cb(null, statsOf(node.directory, node.data?.length ?? 0));
  }

  readdir(path: string, cb: (err: Error | null, entries?: FileEntryWithStats[]) => void): void {
    const node = this.nodes.get(path);
    if (!node?.directory) return cb(missing(path));

    const prefix = path === "/" ? "/" : `${path}/`;
    const entries: FileEntryWithStats[] = [...this.nodes.entries()]
      .filter(([child]) => child !== path && child.startsWith(prefix))
      .filter(([child]) => !child.slice(prefix.length).includes("/"))
      .map(([child, value]) => ({
        filename: child.slice(prefix.length),
        longname: "",
        attrs: statsOf(value.directory, value.data?.length ?? 0),
      }));
    cb(null, entries);
  }

  readFile(path: string, cb: (err: Error | null, data?: Buffer) => void): void {
    const node = this.nodes.get(path);
    if (!node || node.directory) return cb(missing(path));
    cb(null, node.data ?? Buffer.alloc(0));
  }

  mkdir(path: string, cb: (err?: Error | null) => void): void {
    if (this.nodes.has(path)) return cb(new Error("Failure"));
    this.nodes.set(path, { directory: true });
    cb(null);
  }

  rmdir(path: string, cb: (err?: Error | null) => void): void {
    const node = this.nodes.get(path);
    if (!node?.directory) return cb(missing(path));
    this.nodes.delete(path);
    cb(null);
  }

  unlink(path: string, cb: (err?: Error | null) => void): void {
    const node = this.nodes.get(path);
    if (!node || node.directory) return cb(missing(path));
    this.nodes.delete(path);
    cb(null);
  }

  rename(from: string, to: string, cb: (err?: Error | null) => void): void {
    const node = this.nodes.get(from);
    if (!node) return cb(missing(from));
    this.nodes.delete(from);
    this.nodes.set(to, node);
    cb(null);
  }

  createReadStream(path: string): Readable {
    const node = this.nodes.get(path);
    if (!node || node.directory) {
      const stream = new Readable({ read: () => undefined });
      process.nextTick(() => stream.emit("error", missing(path)));
      return stream;
    }
    return Readable.from([node.data ?? Buffer.alloc(0)]);
  }

  createWriteStream(path: string, options: { flags: "w" | "a" }): Writable {
    const chunks: Buffer[] = [];
    const existing = options.flags === "a" ? this.nodes.get(path)?.data : undefined;
    return new Writable({
      write: (chunk: Buffer, _encoding, done) => {
        chunks.push(Buffer.from(chunk));
        done();
      },
      final: (done) => {
        this.nodes.set(path, {
          directory: false,
          data: Buffer.concat([...(existing ? [existing] : []), ...chunks]),
        });
        done();
      },
    });
  }
}

function statsOf(directory: boolean, size: number): Stats {
  return {
    mode: directory ? 0o755 : 0o644,
    uid: 1000,
    gid: 1000,
    size,
    atime: 1_700_000_000,
    mtime: 1_700_000_000,
    isDirectory: () => directory,
    isFile: () => !directory,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isSymbolicLink: () => false,
    isFIFO: () => false,
    isSocket: () => false,
  };
}

function missing(path: string): Error & { code: number } {
  return Object.assign(new Error(`No such file: ${path}`), { code: 2 });
}

const ROOT = "/home/me";

function useProvider(sftp: FakeSftp) {
  const provider = createRemoteFileProvider({
    root: ROOT,
    openSession: async (): Promise<SftpSession> => {
      sftp.released += 0;
      return {
        sftp: sftp as unknown as SFTPWrapper,
        release: () => {
          sftp.released += 1;
        },
      };
    },
  });
  sftp.nodes.set(`${ROOT}/notes`, { directory: true });
  sftp.nodes.set(`${ROOT}/notes/todo.md`, { directory: false, data: Buffer.from("# todo") });
  sftp.nodes.set(`${ROOT}/.env`, { directory: false, data: Buffer.from("SECRET=1") });
  return provider;
}

describe("remote file provider", () => {
  it("lists a directory with the size and mtime the machine reports", async () => {
    const sftp = new FakeSftp(ROOT);
    const provider = useProvider(sftp);

    const listing = await provider.list(ROOT);

    expect(listing.entries.map((entry) => [entry.name, entry.kind, entry.size])).toEqual([
      ["notes", "directory", 0],
      [".env", "file", 8],
    ]);
    expect(listing.entries[0]?.modified).toBe(1_700_000_000_000);
  });

  it("reads a file's bytes and the type its name implies", async () => {
    const sftp = new FakeSftp(ROOT);
    const provider = useProvider(sftp);

    const file = await provider.read(`${ROOT}/notes/todo.md`);

    expect(Buffer.from(file.buffer).toString("utf8")).toBe("# todo");
    expect(file.mimeType).toContain("text/markdown");
  });

  it("answers null for a path the machine does not have", async () => {
    const provider = useProvider(new FakeSftp(ROOT));

    await expect(provider.stat(`${ROOT}/gone.md`)).resolves.toBeNull();
  });

  it("streams a file's bytes for a download", async () => {
    const sftp = new FakeSftp(ROOT);
    const provider = useProvider(sftp);

    const stream = await provider.openReadStream(`${ROOT}/notes/todo.md`);
    const chunks: Buffer[] = [];
    for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
      chunks.push(Buffer.from(chunk));
    }

    expect(Buffer.concat(chunks).toString("utf8")).toBe("# todo");
    expect(sftp.released).toBeGreaterThan(0);
  });

  it("makes every directory in a path, and writes and appends inside it", async () => {
    const sftp = new FakeSftp(ROOT);
    const provider = useProvider(sftp);

    await provider.createDirectory(`${ROOT}/a/b`);
    await provider.append(`${ROOT}/a/b/log.txt`, Buffer.from("one\n"));
    await provider.append(`${ROOT}/a/b/log.txt`, Buffer.from("two\n"));

    expect(sftp.nodes.get(`${ROOT}/a/b/log.txt`)?.data?.toString()).toBe("one\ntwo\n");
  });

  it("renames a file, and can copy it", async () => {
    const sftp = new FakeSftp(ROOT);
    const provider = useProvider(sftp);

    await provider.copy(`${ROOT}/notes/todo.md`, `${ROOT}/notes/copy.md`);
    await provider.rename(`${ROOT}/notes/copy.md`, `${ROOT}/notes/moved.md`);

    await expect(provider.read(`${ROOT}/notes/moved.md`)).resolves.toMatchObject({
      buffer: expect.anything(),
    });
    await expect(provider.stat(`${ROOT}/notes/copy.md`)).resolves.toBeNull();
  });

  it("removes a directory with everything in it", async () => {
    const sftp = new FakeSftp(ROOT);
    const provider = useProvider(sftp);

    await provider.remove(`${ROOT}/notes`);

    expect(sftp.nodes.has(`${ROOT}/notes`)).toBe(false);
    expect(sftp.nodes.has(`${ROOT}/notes/todo.md`)).toBe(false);
  });

  it("refuses a path above the home directory", async () => {
    const provider = useProvider(new FakeSftp(ROOT));

    await expect(provider.list("/etc")).rejects.toBeInstanceOf(FileNotFoundError);
    await expect(provider.read("/home/other.md")).rejects.toBeInstanceOf(FileNotFoundError);
    await expect(provider.remove("/home")).rejects.toBeInstanceOf(FileNotFoundError);
  });
});
