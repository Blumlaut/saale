import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import type { Bot, Context } from "grammy";

// ─── Mocks ───────────────────────────────────────────────────────────────────

const { mockIsConfigured, mockUploadFile } = vi.hoisted(() => ({
  mockIsConfigured: vi.fn(() => false),
  mockUploadFile: vi.fn(),
}));

vi.mock("@/lib/terminal/client", () => ({
  isConfigured: mockIsConfigured,
  uploadFile: mockUploadFile,
}));

const mockFetch = vi.fn();

let filesModule: typeof import("@/lib/telegram/files");
let tmpRoot: string;

/** Build a minimal grammy Bot double with a canned getFile response. */
function makeBot(filePath: string, fileId: string): Bot<Context> {
  return {
    token: "TEST:TOKEN",
    api: {
      getFile: vi.fn().mockResolvedValue({ file_path: filePath, file_id: fileId }),
    },
  } as unknown as Bot<Context>;
}

/** Stub the global fetch to serve a canned binary payload. */
function stubDownload(content: Uint8Array, ok = true, status = 200, statusText = "OK") {
  mockFetch.mockResolvedValue({
    ok,
    status,
    statusText,
    arrayBuffer: async () =>
      content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength),
  });
}

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "saale-tg-files-"));
  vi.stubEnv("UPLOADS_DIR", tmpRoot);
  vi.resetModules();
  filesModule = await import("@/lib/telegram/files");
});

afterAll(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", mockFetch);
  mockIsConfigured.mockReturnValue(false);
  mockUploadFile.mockResolvedValue({ path: "/home/u12345678/telegram_files/doc.pdf", size: 0 });
});

// ─── downloadAndProcessTelegramFile ──────────────────────────────────────────

describe("downloadAndProcessTelegramFile", () => {
  it("uploads documents into the Open Terminal workspace when terminal is configured", async () => {
    const content = Buffer.from("pdf-bytes-here");
    mockIsConfigured.mockReturnValue(true);
    mockUploadFile.mockResolvedValue({
      path: "/home/u12345678/telegram_files/report.pdf",
      size: content.length,
    });
    stubDownload(new Uint8Array(content));

    const bot = makeBot("files/123/report.pdf", "123");
    const result = await filesModule.downloadAndProcessTelegramFile(bot, "user-1", {
      fileId: "123",
      mimeType: "application/pdf",
      fileName: "report.pdf",
    });

    // The document must be uploaded to the container (not saved on the host)
    expect(mockUploadFile).toHaveBeenCalledTimes(1);
    const [fileName, uploadedBuffer, options] = mockUploadFile.mock.calls[0]!;
    expect(fileName).toBe("report.pdf");
    expect(Buffer.from(uploadedBuffer as Uint8Array).equals(content)).toBe(true);
    expect(options).toEqual({ directory: "telegram_files", userId: "user-1" });

    // The prompt path is the container-absolute path the agent can reach
    expect(result.filePath).toBe("/home/u12345678/telegram_files/report.pdf");
    expect(result.size).toBe(content.length);
    expect(result.imageData).toBeUndefined();
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.telegram.org/file/botTEST:TOKEN/files/123/report.pdf",
    );
  });

  it("saves documents to the local uploads directory when terminal is not configured", async () => {
    const content = Buffer.from("local document content");
    mockIsConfigured.mockReturnValue(false);
    stubDownload(new Uint8Array(content));

    const bot = makeBot("files/456/notes.txt", "456");
    const result = await filesModule.downloadAndProcessTelegramFile(bot, "user-2", {
      fileId: "456",
      mimeType: "text/plain",
      fileName: "notes.txt",
    });

    expect(mockUploadFile).not.toHaveBeenCalled();
    expect(result.filePath).toBe(path.join(tmpRoot, "user-2", "telegram_files", "notes.txt"));
    expect(result.size).toBe(content.length);

    const written = await fs.readFile(path.join(tmpRoot, "user-2", "telegram_files", "notes.txt"));
    expect(written.equals(content)).toBe(true);
  });

  it("keeps per-user isolation in the local uploads directory", async () => {
    stubDownload(new Uint8Array(Buffer.from("other user's file")));

    const bot = makeBot("files/789/a.txt", "789");
    const result = await filesModule.downloadAndProcessTelegramFile(bot, "user-9", {
      fileId: "789",
      mimeType: "text/plain",
      fileName: "a.txt",
    });

    // The file must live under user-9's directory, not another user's
    expect(result.filePath).toBe(path.join(tmpRoot, "user-9", "telegram_files", "a.txt"));
    const written = await fs.readFile(path.join(tmpRoot, "user-9", "telegram_files", "a.txt"));
    expect(written.toString()).toBe("other user's file");
    await expect(
      fs.access(path.join(tmpRoot, "user-2", "telegram_files", "a.txt")),
    ).rejects.toThrow();
  });

  it("returns base64 image data for image MIME types without writing or uploading a file", async () => {
    const content = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    mockIsConfigured.mockReturnValue(true); // even with terminal: images go to the model, not disk
    stubDownload(content);

    const bot = makeBot("files/photo.jpg", "p1");
    const result = await filesModule.downloadAndProcessTelegramFile(bot, "user-1", {
      fileId: "p1",
      mimeType: "image/jpeg",
      fileName: "photo.jpg",
    });

    expect(result.imageData).toEqual({
      type: "image",
      data: Buffer.from(content).toString("base64"),
      mimeType: "image/jpeg",
    });
    expect(result.filePath).toBeUndefined();
    expect(result.size).toBeUndefined();
    expect(mockUploadFile).not.toHaveBeenCalled();
    await expect(fs.access(path.join(tmpRoot, "user-1", "telegram_files"))).rejects.toThrow();
  });

  it("sanitizes path traversal from filenames before saving", async () => {
    stubDownload(new Uint8Array(Buffer.from("evil")));

    const bot = makeBot("files/evil", "e1");
    const result = await filesModule.downloadAndProcessTelegramFile(bot, "user-1", {
      fileId: "e1",
      mimeType: "application/x-msdownload",
      fileName: "../../etc/passwd",
    });

    // Slashes are replaced, so the file stays inside the user directory
    expect(path.basename(result.filePath!)).toBe(".._.._etc_passwd");
    expect(result.filePath).toBe(
      path.join(tmpRoot, "user-1", "telegram_files", ".._.._etc_passwd"),
    );
    await expect(fs.readFile(path.join(tmpRoot, "user-1", ".._.._etc_passwd"))).rejects.toThrow();
  });

  it("defaults to a generated name and octet-stream MIME when metadata is missing", async () => {
    stubDownload(new Uint8Array(Buffer.from("bytes")));

    const bot = makeBot("files/anonymous", "abc123");
    const result = await filesModule.downloadAndProcessTelegramFile(bot, "user-1", {
      fileId: "abc123",
    });

    expect(result.fileName).toBe("telegram_abc123.dat");
    expect(result.mimeType).toBe("application/octet-stream");
  });

  it("rejects files larger than the 20MB Telegram limit", async () => {
    const oversized = new Uint8Array(20 * 1024 * 1024 + 1);
    stubDownload(oversized);

    const bot = makeBot("files/big.bin", "big");
    await expect(
      filesModule.downloadAndProcessTelegramFile(bot, "user-1", {
        fileId: "big",
        mimeType: "application/octet-stream",
        fileName: "big.bin",
      }),
    ).rejects.toThrow(/too large/);
    expect(mockUploadFile).not.toHaveBeenCalled();
  });

  it("throws a descriptive error when the Telegram CDN download fails", async () => {
    stubDownload(new Uint8Array([]), false, 404, "Not Found");

    const bot = makeBot("files/missing", "nope");
    await expect(
      filesModule.downloadAndProcessTelegramFile(bot, "user-1", {
        fileId: "nope",
        mimeType: "application/pdf",
        fileName: "missing.pdf",
      }),
    ).rejects.toThrow("Failed to download Telegram file: 404 Not Found");
  });

  it("propagates Open Terminal upload failures", async () => {
    stubDownload(new Uint8Array(Buffer.from("data")));
    mockIsConfigured.mockReturnValue(true);
    mockUploadFile.mockRejectedValue(new Error("Open Terminal error 500: boom"));

    const bot = makeBot("files/1.pdf", "1");
    await expect(
      filesModule.downloadAndProcessTelegramFile(bot, "user-1", {
        fileId: "1",
        mimeType: "application/pdf",
        fileName: "1.pdf",
      }),
    ).rejects.toThrow("Open Terminal error 500: boom");
  });
});

// ─── buildFilePromptText ─────────────────────────────────────────────────────

describe("buildFilePromptText", () => {
  it("points the agent at the container path for documents", () => {
    const text = filesModule.buildFilePromptText(
      {
        filePath: "/home/u12345678/telegram_files/contract.pdf",
        size: 1234,
        mimeType: "application/pdf",
        fileName: "contract.pdf",
      },
      "can you review this?",
    );

    expect(text).toBe(
      "can you review this? [File attached: contract.pdf (application/pdf) at /home/u12345678/telegram_files/contract.pdf]",
    );
  });

  it("announces image attachments without a path", () => {
    const text = filesModule.buildFilePromptText(
      {
        imageData: { type: "image", data: "QUJD", mimeType: "image/jpeg" },
        mimeType: "image/jpeg",
        fileName: "screenshot.jpg",
      },
      undefined,
    );

    expect(text).toBe("[Image attached: screenshot.jpg (image/jpeg)]");
  });

  it("returns empty string when there is nothing to describe", () => {
    const text = filesModule.buildFilePromptText({ mimeType: "x", fileName: "x" }, undefined);
    expect(text).toBe("");
  });
});
