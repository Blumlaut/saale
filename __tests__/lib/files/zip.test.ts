import { describe, expect, it, vi } from "vitest";
import { FileLimitError, FilePathEscapeError } from "@/lib/files/errors";
import { planZip, streamZip } from "@/lib/files/zip";
import { createFakeProvider, readZipEntries } from "../../helpers/fake-file-provider";

// Shrink the ceilings so a test can hit them without building megabytes.
vi.mock("@/lib/files/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/files/config")>()),
  MAX_ZIP_ENTRIES: 4,
  MAX_ZIP_BYTES: 4096,
  MAX_DOWNLOAD_BYTES: 1024,
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
    expect(plan.totalBytes).toBe("export const app = 1;".length + "deep".length);
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

  it("refuses a selection larger than the byte ceiling", async () => {
    const tree = {
      [`${ROOT}/big`]: null,
      [`${ROOT}/big/report.bin`]: "x".repeat(2000),
    };
    const provider = createFakeProvider(tree);

    await expect(
      planZip(provider, ROOT, [`${ROOT}/big`], { includeDotfiles: false }),
    ).rejects.toBeInstanceOf(FileLimitError);
  });

  it("refuses a single file larger than the served-file ceiling", async () => {
    const tree = { [`${ROOT}/huge.bin`]: "x".repeat(2000) };
    const provider = createFakeProvider(tree);

    await expect(
      planZip(provider, ROOT, [`${ROOT}/huge.bin`], { includeDotfiles: false }),
    ).rejects.toBeInstanceOf(FileLimitError);
  });

  it("reports a missing entry rather than writing an empty archive", async () => {
    const provider = createFakeProvider(TREE);
    await expect(
      planZip(provider, ROOT, [`${ROOT}/gone.txt`], { includeDotfiles: false }),
    ).rejects.toThrow(/not found/i);
  });
});

describe("streamZip", () => {
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
