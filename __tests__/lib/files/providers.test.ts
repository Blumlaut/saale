import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FilePathEscapeError } from "@/lib/files/errors";
import { createLocalFileProvider } from "@/lib/files/local-provider";

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
    // A folder an agent deleted is gone, not empty  the same thing the
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

  it("hands what it creates to the configured owner", async () => {
    const provider = createLocalFileProvider({
      root,
      owner: { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 },
    });

    await provider.write(path.join(root, "notes", "todo.md"), Buffer.from("x"));
    await provider.createDirectory(path.join(root, "fresh"));

    const owned = await fs.stat(path.join(root, "notes", "todo.md"));
    expect(owned.uid).toBe(process.getuid?.());
    // The directories it had to create are handed over too, or the account
    // could not write next to the file.
    expect((await fs.stat(path.join(root, "notes"))).uid).toBe(process.getuid?.());
  });

  it("refuses a traversal even when the target exists on disk", async () => {
    const provider = createLocalFileProvider({ root });

    await expect(provider.read(path.join(root, "..", "escape.txt"))).rejects.toBeInstanceOf(
      FilePathEscapeError,
    );
  });
});
