import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FilePathEscapeError } from "@/lib/files/errors";
import { createLocalFileProvider } from "@/lib/files/local-provider";
import { createTerminalFileProvider } from "@/lib/files/terminal-provider";

vi.mock("@/lib/terminal/client", () => ({
  listDirectory: vi.fn(),
  readFileBinary: vi.fn(),
  uploadFile: vi.fn(),
  createDirectory: vi.fn(),
  moveFile: vi.fn(),
  deleteFile: vi.fn(),
  isConfigured: vi.fn(() => true),
}));

import * as terminal from "@/lib/terminal/client";

const ROOT = "/home/abc12345";

describe("terminal file provider", () => {
  beforeEach(() => vi.clearAllMocks());

  it("converts the container's epoch seconds into milliseconds", async () => {
    vi.mocked(terminal.listDirectory).mockResolvedValue({
      dir: ROOT,
      writable: true,
      entries: [
        { name: "app.ts", type: "file", size: 21, modified: 1791904714.4451656, writable: true },
        { name: "src", type: "directory", size: 4096, modified: 1791904714, writable: true },
      ],
    });

    const provider = createTerminalFileProvider({ identity: "abc12345", root: ROOT });
    const listing = await provider.list(ROOT);

    expect(terminal.listDirectory).toHaveBeenCalledWith(ROOT, { userId: "abc12345" });
    expect(listing.entries[0]).toMatchObject({
      name: "app.ts",
      kind: "file",
      size: 21,
      modified: 1791904714445,
    });
    expect(listing.entries.map((entry) => entry.kind)).toEqual(["file", "directory"]);
  });

  it("takes the type from the extension when the container is vague", async () => {
    vi.mocked(terminal.readFileBinary).mockResolvedValue({
      path: `${ROOT}/app.ts`,
      mimeType: "application/octet-stream",
      buffer: Buffer.from("export {}"),
    });
    const provider = createTerminalFileProvider({ identity: "abc12345", root: ROOT });

    await expect(provider.read(`${ROOT}/app.ts`)).resolves.toMatchObject({
      mimeType: "text/typescript; charset=utf-8",
    });

    // A type the container knows better than the extension does is kept.
    vi.mocked(terminal.readFileBinary).mockResolvedValue({
      path: `${ROOT}/shot.png`,
      mimeType: "image/png",
      buffer: Buffer.from([0x89, 0x50]),
    });
    await expect(provider.read(`${ROOT}/shot.png`)).resolves.toMatchObject({
      mimeType: "image/png",
    });
  });

  it("splits a write into the directory and name the upload endpoint wants", async () => {
    vi.mocked(terminal.uploadFile).mockResolvedValue({ path: `${ROOT}/notes/todo.md`, size: 1 });
    const provider = createTerminalFileProvider({ identity: "abc12345", root: ROOT });

    await provider.write(`${ROOT}/notes/todo.md`, Buffer.from("x"));

    expect(terminal.uploadFile).toHaveBeenCalledWith("todo.md", expect.any(Buffer), {
      directory: `${ROOT}/notes`,
      userId: "abc12345",
    });
  });

  it("finds an entry through its parent listing and reports a miss as null", async () => {
    vi.mocked(terminal.listDirectory).mockImplementation(async (dir) => {
      if (dir !== `${ROOT}/notes`) {
        throw new Error("Open Terminal error 404: Path not found");
      }
      return {
        dir,
        writable: true,
        entries: [
          { name: "todo.md", type: "file", size: 12, modified: 1791904714, writable: true },
        ],
      };
    });
    const provider = createTerminalFileProvider({ identity: "abc12345", root: ROOT });

    await expect(provider.stat(`${ROOT}/notes/todo.md`)).resolves.toMatchObject({
      kind: "file",
      size: 12,
      modified: 1791904714000,
    });
    await expect(provider.stat(`${ROOT}/notes/gone.md`)).resolves.toBeNull();
    // A directory that is not there reads as a miss, not as a failure.
    await expect(provider.stat(`${ROOT}/absent/todo.md`)).resolves.toBeNull();
  });

  it("treats deleting an already-removed path as success but surfaces real failures", async () => {
    const provider = createTerminalFileProvider({ identity: "abc12345", root: ROOT });

    vi.mocked(terminal.deleteFile).mockRejectedValueOnce(
      new Error("Open Terminal error 404: Path not found"),
    );
    await expect(provider.remove(`${ROOT}/gone.txt`)).resolves.toBeUndefined();

    vi.mocked(terminal.deleteFile).mockRejectedValueOnce(
      new Error("Open Terminal error 500: boom"),
    );
    await expect(provider.remove(`${ROOT}/x.txt`)).rejects.toThrow("500");
  });
});

describe("local file provider", () => {
  let root: string;
  let outside: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "saale-files-"));
    outside = await fs.mkdtemp(path.join(os.tmpdir(), "saale-outside-"));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });

  it("writes, lists, renames and removes inside the workspace", async () => {
    const provider = createLocalFileProvider({ root });

    await provider.createDirectory(path.join(root, "notes"));
    await provider.write(path.join(root, "notes", "todo.md"), Buffer.from("# todo"));

    const listing = await provider.list(path.join(root, "notes"));
    expect(listing.entries.map((entry) => entry.name)).toEqual(["todo.md"]);

    await provider.rename(path.join(root, "notes", "todo.md"), path.join(root, "notes", "done.md"));
    await expect(provider.read(path.join(root, "notes", "done.md"))).resolves.toMatchObject({
      mimeType: "text/markdown; charset=utf-8",
    });

    await provider.remove(path.join(root, "notes"));
    // A folder an agent deleted is gone, not empty — the same thing the
    // terminal backend reports, so the UI can say so once.
    await expect(provider.list(path.join(root, "notes"))).rejects.toThrow(/ENOENT/);
  });

  it("creates and lists a workspace that does not exist yet", async () => {
    const provider = createLocalFileProvider({ root: path.join(root, "fresh") });

    await expect(provider.list(path.join(root, "fresh"))).resolves.toMatchObject({ entries: [] });
  });

  it("reports a missing entry as null instead of throwing", async () => {
    const provider = createLocalFileProvider({ root });

    await expect(provider.stat(path.join(root, "absent.txt"))).resolves.toBeNull();
  });

  it("refuses a symlink that leaves the workspace", async () => {
    const provider = createLocalFileProvider({ root });
    await fs.writeFile(path.join(outside, "secret.txt"), "top secret");
    await fs.symlink(path.join(outside, "secret.txt"), path.join(root, "link.txt"));
    await fs.symlink(outside, path.join(root, "linkdir"));

    // The whole reason this backend re-checks: the path guard is textual, so a
    // symlink would otherwise be followed straight out of the volume.
    await expect(provider.read(path.join(root, "link.txt"))).rejects.toBeInstanceOf(
      FilePathEscapeError,
    );
    await expect(provider.list(path.join(root, "linkdir"))).rejects.toBeInstanceOf(
      FilePathEscapeError,
    );
    await expect(
      provider.write(path.join(root, "linkdir", "new.txt"), Buffer.from("x")),
    ).rejects.toBeInstanceOf(FilePathEscapeError);
  });

  it("still follows a symlink that stays inside the workspace", async () => {
    const provider = createLocalFileProvider({ root });
    await fs.writeFile(path.join(root, "real.txt"), "inside");
    await fs.symlink(path.join(root, "real.txt"), path.join(root, "alias.txt"));

    await expect(provider.read(path.join(root, "alias.txt"))).resolves.toMatchObject({
      mimeType: "text/plain; charset=utf-8",
    });
  });

  it("refuses a traversal even when the target exists on disk", async () => {
    const provider = createLocalFileProvider({ root });

    await expect(provider.read(path.join(root, "..", "escape.txt"))).rejects.toBeInstanceOf(
      FilePathEscapeError,
    );
  });
});
