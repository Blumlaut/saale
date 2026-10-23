import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FileNotFoundError, FilePathEscapeError } from "@/lib/files/errors";
import { readWorkspaceFile } from "@/lib/files/workspace-file";
import { userIdentity } from "@/lib/sandbox/identity";

const userId = "user-1";

let workspacesRoot: string;
let userRoot: string;

beforeAll(async () => {
  workspacesRoot = await fs.mkdtemp(path.join(os.tmpdir(), "saale-workspace-file-"));
  vi.stubEnv("SANDBOX_WORKSPACES_DIR", workspacesRoot);
  vi.stubEnv("SANDBOX_USER", "root");
  userRoot = path.join(workspacesRoot, userIdentity(userId));
  await fs.mkdir(userRoot, { recursive: true });
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await fs.rm(workspacesRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await fs.rm(userRoot, { recursive: true, force: true });
  await fs.mkdir(userRoot, { recursive: true });
});

/** Write a file into the user's workspace and return its relative path. */
async function writeWorkspaceFile(name: string, content: Buffer | string): Promise<string> {
  await fs.mkdir(path.dirname(path.join(userRoot, name)), { recursive: true });
  await fs.writeFile(path.join(userRoot, name), content);
  return name;
}

describe("readWorkspaceFile", () => {
  it("reads a file with its name, size and type", async () => {
    const relative = await writeWorkspaceFile("reports/q3.pdf", Buffer.from("pdf-bytes"));

    const file = await readWorkspaceFile(userId, relative);

    expect(file).toMatchObject({ fileName: "q3.pdf", size: 9, mimeType: "application/pdf" });
    expect(Buffer.from(file.buffer).toString()).toBe("pdf-bytes");
  });

  it("hands back any file type as-is, extension unknown or not", async () => {
    const relative = await writeWorkspaceFile("model.gguf", Buffer.from([0x00, 0x01, 0xff]));

    const file = await readWorkspaceFile(userId, relative);

    expect(file.mimeType).toBe("application/octet-stream");
    expect(file.size).toBe(3);
  });

  it("refuses a path that climbs out of the workspace", async () => {
    await writeWorkspaceFile("notes.md", "hello");

    await expect(readWorkspaceFile(userId, "../user-2/secret.txt")).rejects.toBeInstanceOf(
      FilePathEscapeError,
    );
  });

  it("reports a missing file rather than an empty one", async () => {
    await expect(readWorkspaceFile(userId, "nope.pdf")).rejects.toBeInstanceOf(FileNotFoundError);
  });

  it("reports a directory as such", async () => {
    await fs.mkdir(path.join(userRoot, "reports"), { recursive: true });

    await expect(readWorkspaceFile(userId, "reports")).rejects.toThrow("Not a file: reports");
  });

  it("refuses a file over the ceiling without reading it", async () => {
    const relative = await writeWorkspaceFile("huge.bin", Buffer.alloc(1024));

    await expect(readWorkspaceFile(userId, relative, { maxBytes: 512 })).rejects.toThrow(
      /^File too large: 0\.0MB\. Max: 0MB\.$/,
    );
  });

  it("reads a file exactly at the shared ceiling", async () => {
    const relative = await writeWorkspaceFile("backup.tar", Buffer.from("data"));

    await expect(readWorkspaceFile(userId, relative, { maxBytes: 4 })).resolves.toMatchObject({
      size: 4,
    });
  });

  it("does not resolve a name into another identity's directory", async () => {
    const other = path.join(workspacesRoot, "user-2");
    await fs.mkdir(other, { recursive: true });
    await fs.writeFile(path.join(other, "secret.txt"), "top secret");

    await expect(readWorkspaceFile(userId, "secret.txt")).rejects.toBeInstanceOf(FileNotFoundError);
    await expect(readWorkspaceFile(userId, "../user-2/secret.txt")).rejects.toBeInstanceOf(
      FilePathEscapeError,
    );
  });

  it("refuses a symlink that points into another identity's directory", async () => {
    const other = path.join(workspacesRoot, "user-2");
    await fs.mkdir(other, { recursive: true });
    await fs.writeFile(path.join(other, "secret.txt"), "top secret");
    await fs.symlink(path.join(other, "secret.txt"), path.join(userRoot, "link.txt"));

    await expect(readWorkspaceFile(userId, "link.txt")).rejects.toBeInstanceOf(FilePathEscapeError);
  });
});
