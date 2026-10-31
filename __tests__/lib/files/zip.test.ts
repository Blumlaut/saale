import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FileLimitError, FilePathEscapeError } from "@/lib/files/errors";
import { planZip, streamZip } from "@/lib/files/zip";
import { createLocalFileProvider } from "@/lib/files/local-provider";
import { createFakeProvider, readZipEntries } from "../../helpers/fake-file-provider";

// Shrink the entry ceiling so a test can hit it without building a big tree.
vi.mock("@/lib/files/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/files/config")>()),
  MAX_ZIP_ENTRIES: 4,
}));

const ROOT = "/workspace";

const TREE = {
  [ROOT]: null,
  [`${ROOT}/notes.md`]: "# notes",
  [`${ROOT}/src`]: null,
  [`${ROOT}/src/app.ts`]: "export const app = 1;",
  [`${ROOT}/src/deep`]: null,
  [`${ROOT}/src/deep/nested.txt`]: "deep",
  [`${ROOT}/empty`]: null,
  [`${ROOT}/project`]: null,
  [`${ROOT}/project/.env`]: "SECRET=1",
  [`${ROOT}/project/main.ts`]: "console.log(1);",
  [`${ROOT}/project/readme.md`]: "hello",
};

/** Drain a web stream into one buffer, the way a client would. */
async function collect(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

describe("planZip", () => {
  it("names entries relative to the folder being browsed", async () => {
    const provider = createFakeProvider(TREE);
    const plan = await planZip(provider, `${ROOT}/src`, [`${ROOT}/src/app.ts`], {
      includeDotfiles: false,
    });

    expect(plan.entries.map((entry) => entry.name)).toEqual(["app.ts"]);
    expect(plan.entries.map((entry) => entry.size)).toEqual(["export const app = 1;".length]);
    expect(plan.fileName).toBe("files.zip");
  });

  it("keeps a selected folder's shape, including nested folders", async () => {
    const provider = createFakeProvider(TREE);
    const plan = await planZip(provider, ROOT, [`${ROOT}/src`], { includeDotfiles: false });

    expect(plan.entries.map((entry) => entry.name)).toEqual(["src/app.ts", "src/deep/nested.txt"]);
    // A single folder downloads as that folder, which is what a person expects.
    expect(plan.fileName).toBe("src.zip");
  });

  it("records an empty folder so it survives the round trip", async () => {
    const provider = createFakeProvider(TREE);
    const plan = await planZip(provider, ROOT, [`${ROOT}/empty`], { includeDotfiles: false });

    expect(plan.entries).toEqual([]);
    expect(plan.emptyDirectories.map((dir) => dir.name)).toEqual(["empty"]);
  });

  it("leaves dotfiles out unless they are asked for", async () => {
    const provider = createFakeProvider(TREE);

    const hidden = await planZip(provider, ROOT, [`${ROOT}/project`], { includeDotfiles: false });
    expect(hidden.entries.map((entry) => entry.name)).toEqual([
      "project/main.ts",
      "project/readme.md",
    ]);

    const shown = await planZip(provider, ROOT, [`${ROOT}/project`], { includeDotfiles: true });
    expect(shown.entries.map((entry) => entry.name)).toContain("project/.env");
  });

  it("counts an entry once when a folder and a file inside it are both selected", async () => {
    const provider = createFakeProvider(TREE);
    const plan = await planZip(provider, ROOT, [`${ROOT}/project`, `${ROOT}/project/main.ts`], {
      includeDotfiles: false,
    });

    const names = plan.entries.map((entry) => entry.name);
    expect(names.filter((name) => name === "project/main.ts")).toHaveLength(1);
    expect(names).toContain("project/readme.md");
  });

  it("refuses a selection outside the folder being browsed", async () => {
    const provider = createFakeProvider(TREE);
    await expect(
      planZip(provider, `${ROOT}/src`, [`${ROOT}/notes.md`], { includeDotfiles: false }),
    ).rejects.toBeInstanceOf(FilePathEscapeError);
  });

  it("refuses the folder being browsed as its own selection", async () => {
    const provider = createFakeProvider(TREE);
    await expect(
      planZip(provider, `${ROOT}/src`, [`${ROOT}/src`], { includeDotfiles: false }),
    ).rejects.toBeInstanceOf(FilePathEscapeError);
  });

  it("refuses more entries than the ceiling instead of truncating", async () => {
    const tree: Record<string, string | null> = { [`${ROOT}/many`]: null };
    for (let index = 0; index < 5; index += 1) tree[`${ROOT}/many/f${index}.txt`] = "x";
    const provider = createFakeProvider(tree);

    await expect(
      planZip(provider, ROOT, [`${ROOT}/many`], { includeDotfiles: false }),
    ).rejects.toBeInstanceOf(FileLimitError);
  });

  it("plans a selection of any size, because nothing is buffered", async () => {
    // A download has no ceiling: the bytes go from the disk into the archive a
    // chunk at a time, so a huge file costs the same memory as a small one.
    const tree = {
      [`${ROOT}/big`]: null,
      [`${ROOT}/big/report.bin`]: "x".repeat(2_000_000),
      [`${ROOT}/big/notes.md`]: "# notes",
    };
    const provider = createFakeProvider(tree);

    const plan = await planZip(provider, ROOT, [`${ROOT}/big`], { includeDotfiles: false });

    expect(plan.entries.map((entry) => entry.name)).toEqual(["big/report.bin", "big/notes.md"]);
  });

  it("reports a missing entry rather than writing an empty archive", async () => {
    const provider = createFakeProvider(TREE);
    await expect(
      planZip(provider, ROOT, [`${ROOT}/gone.txt`], { includeDotfiles: false }),
    ).rejects.toThrow(/not found/i);
  });
});

describe("streamZip", () => {
  it("streams a real workspace's files into the archive", async () => {
    // The bytes go from the disk into the archive without a buffer in between,
    // which is the whole reason a large selection has no ceiling.
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "saale-zip-"));
    try {
      const content = Buffer.alloc(1024 * 1024, 3);
      await fs.mkdir(path.join(root, "dump"));
      await fs.writeFile(path.join(root, "dump", "blob.bin"), content);
      await fs.writeFile(path.join(root, "dump", "notes.md"), "# notes");
      const provider = createLocalFileProvider({ root });

      const plan = await planZip(provider, root, [path.join(root, "dump")], {
        includeDotfiles: false,
      });
      const archive = readZipEntries(await collect(streamZip(provider, plan)));

      expect(archive.map((entry) => entry.name).sort()).toEqual(["dump/blob.bin", "dump/notes.md"]);
      expect(archive.find((entry) => entry.name === "dump/blob.bin")?.content.equals(content)).toBe(
        true,
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("produces a real archive whose entries inflate back to their bytes", async () => {
    const provider = createFakeProvider(TREE);
    const plan = await planZip(provider, ROOT, [`${ROOT}/src`, `${ROOT}/notes.md`], {
      includeDotfiles: false,
    });

    const archive = readZipEntries(await collect(streamZip(provider, plan)));

    expect(archive.map((entry) => entry.name).sort()).toEqual([
      "notes.md",
      "src/app.ts",
      "src/deep/nested.txt",
    ]);
    expect(archive.find((entry) => entry.name === "src/app.ts")?.content.toString()).toBe(
      "export const app = 1;",
    );
    expect(archive.find((entry) => entry.name === "notes.md")?.content.toString()).toBe("# notes");
  });

  it("writes an empty folder as a directory entry", async () => {
    const provider = createFakeProvider(TREE);
    const plan = await planZip(provider, ROOT, [`${ROOT}/empty`], { includeDotfiles: false });

    const archive = readZipEntries(await collect(streamZip(provider, plan)));

    expect(archive.map((entry) => entry.name)).toEqual(["empty/"]);
    expect(archive.map((entry) => entry.size)).toEqual([0]);
  });
});
