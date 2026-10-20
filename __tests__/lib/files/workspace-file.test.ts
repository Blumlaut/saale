import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// ─── Mocks ───────────────────────────────────────────────────────────────────

const { mockIsConfigured, mockGetTerminalHomeDir, mockReadFileBinary, mockListDirectory } =
  vi.hoisted(() => ({
    mockIsConfigured: vi.fn(() => false),
    mockGetTerminalHomeDir: vi.fn((userId: string) => `/home/${userId}`),
    mockReadFileBinary: vi.fn(),
    mockListDirectory: vi.fn(),
  }));

vi.mock("@/lib/terminal/client", () => ({
  isConfigured: mockIsConfigured,
  getTerminalHomeDir: mockGetTerminalHomeDir,
  readFileBinary: mockReadFileBinary,
  listDirectory: mockListDirectory,
}));

import { FileNotFoundError, FilePathEscapeError } from "@/lib/files/errors";
import { MAX_SHARED_FILE_BYTES, readWorkspaceFile } from "@/lib/files/workspace-file";

const userId = "user-1";

let uploadsRoot: string;

beforeAll(async () => {
  uploadsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "saale-workspace-file-"));
  vi.stubEnv("UPLOADS_DIR", uploadsRoot);
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await fs.rm(uploadsRoot, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  mockIsConfigured.mockReturnValue(false);
});

/** Write a file into the user's local workspace and return its relative path. */
async function writeWorkspaceFile(name: string, content: Buffer | string): Promise<string> {
  await fs.mkdir(path.dirname(path.join(uploadsRoot, userId, name)), { recursive: true });
  await fs.writeFile(path.join(uploadsRoot, userId, name), content);
  return name;
}

// ─── Local workspace (no terminal container) ─────────────────────────────────

describe("readWorkspaceFile  uploads volume", () => {
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
    await fs.mkdir(path.join(uploadsRoot, userId, "reports"), { recursive: true });

    await expect(readWorkspaceFile(userId, "reports")).rejects.toThrow("Not a file: reports");
  });

  it("refuses a file over the ceiling without reading it", async () => {
    const relative = await writeWorkspaceFile("huge.bin", Buffer.alloc(1024));

    await expect(readWorkspaceFile(userId, relative, { maxBytes: 512 })).rejects.toThrow(
      /^File too large: 0\.0MB\. Max: 0MB\.$/,
    );
  });

  it("never resolves a path out of another user's directory", async () => {
    await fs.mkdir(path.join(uploadsRoot, "user-2"), { recursive: true });
    await fs.writeFile(path.join(uploadsRoot, "user-2", "secret.txt"), "top secret");

    await expect(readWorkspaceFile(userId, "secret.txt")).rejects.toBeInstanceOf(FileNotFoundError);
  });
});

// ─── Terminal container ──────────────────────────────────────────────────────

describe("readWorkspaceFile  Open Terminal", () => {
  beforeEach(() => {
    mockIsConfigured.mockReturnValue(true);
    mockGetTerminalHomeDir.mockImplementation((id: string) => `/home/${id}`);
    mockListDirectory.mockResolvedValue({
      dir: `/home/${userId}`,
      writable: true,
      entries: [{ name: "chart.png", type: "file", size: 12, modified: 1, writable: true }],
    });
    mockReadFileBinary.mockResolvedValue({
      path: `/home/${userId}/chart.png`,
      mimeType: "application/octet-stream",
      buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    });
  });

  it("reads through the container and takes the type from the extension", async () => {
    const file = await readWorkspaceFile(userId, "chart.png", { sessionId: "sess-9" });

    expect(mockReadFileBinary).toHaveBeenCalledWith(`/home/${userId}/chart.png`, {
      userId,
      sessionId: "sess-9",
    });
    expect(file).toMatchObject({ fileName: "chart.png", size: 4, mimeType: "image/png" });
  });

  it("omits the session header when the caller has no chat", async () => {
    await readWorkspaceFile(userId, "chart.png");

    expect(mockReadFileBinary).toHaveBeenCalledWith(`/home/${userId}/chart.png`, { userId });
  });

  it("refuses a path that climbs out of the container home", async () => {
    await expect(readWorkspaceFile(userId, "../../etc/passwd")).rejects.toBeInstanceOf(
      FilePathEscapeError,
    );
    expect(mockReadFileBinary).not.toHaveBeenCalled();
  });

  it("refuses a file past the shared ceiling without downloading it", async () => {
    mockListDirectory.mockResolvedValue({
      dir: `/home/${userId}`,
      writable: true,
      entries: [
        {
          name: "backup.tar",
          type: "file",
          size: MAX_SHARED_FILE_BYTES + 1,
          modified: 1,
          writable: true,
        },
      ],
    });

    await expect(readWorkspaceFile(userId, "backup.tar")).rejects.toThrow("File too large: 50.0MB");
    expect(mockReadFileBinary).not.toHaveBeenCalled();
  });

  it("reads a file exactly at the ceiling", async () => {
    mockListDirectory.mockResolvedValue({
      dir: `/home/${userId}`,
      writable: true,
      entries: [
        {
          name: "backup.tar",
          type: "file",
          size: MAX_SHARED_FILE_BYTES,
          modified: 1,
          writable: true,
        },
      ],
    });

    await expect(readWorkspaceFile(userId, "backup.tar")).resolves.toMatchObject({
      size: 4,
    });
  });

  it("does not read a file the container reports as missing", async () => {
    mockListDirectory.mockResolvedValue({ dir: `/home/${userId}`, writable: true, entries: [] });

    await expect(readWorkspaceFile(userId, "gone.pdf")).rejects.toBeInstanceOf(FileNotFoundError);
    expect(mockReadFileBinary).not.toHaveBeenCalled();
  });
});
