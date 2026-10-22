import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import type { Bot, Context } from "grammy";

// ─── Mocks ───────────────────────────────────────────────────────────────────

const { mockReadWorkspaceFile, mockSendTelegramFile } = vi.hoisted(() => ({
  mockReadWorkspaceFile: vi.fn(),
  mockSendTelegramFile: vi.fn(),
}));

vi.mock("@/lib/files/workspace-file", () => ({
  readWorkspaceFile: mockReadWorkspaceFile,
}));

vi.mock("@/lib/telegram/client", () => ({
  sendTelegramFile: mockSendTelegramFile,
}));

const mockFetch = vi.fn();

const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

let filesModule: typeof import("@/lib/telegram/files");
let tmpRoot: string;
/** `user-<id>` directories live directly under the workspaces root. */
const workspaceOf = (userId: string) => path.join(tmpRoot, `user-${userId}`);

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
  vi.stubEnv("SANDBOX_WORKSPACES_DIR", tmpRoot);
  vi.stubEnv("SANDBOX_USER", "root");
  vi.resetModules();
  filesModule = await import("@/lib/telegram/files");
});

afterAll(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", mockFetch);
  // Every case starts from an empty volume, so "nothing was written" is testable.
  for (const entry of await fs.readdir(tmpRoot)) {
    await fs.rm(path.join(tmpRoot, entry), { recursive: true, force: true });
  }
});

// ─── downloadAndProcessTelegramFile ──────────────────────────────────────────

describe("downloadAndProcessTelegramFile", () => {
  it("saves documents into the user's workspace and returns that path", async () => {
    const content = Buffer.from("pdf-bytes-here");
    stubDownload(new Uint8Array(content));

    const bot = makeBot("files/123/report.pdf", "123");
    const result = await filesModule.downloadAndProcessTelegramFile(bot, "user-1", {
      fileId: "123",
      mimeType: "application/pdf",
      fileName: "report.pdf",
    });

    const expected = path.join(workspaceOf("user-1"), "telegram_files", "report.pdf");
    expect(result.filePath).toBe(expected);
    expect(result.size).toBe(content.length);
    expect(result.imageData).toBeUndefined();

    const written = await fs.readFile(expected);
    expect(written.equals(content)).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.telegram.org/file/botTEST:TOKEN/files/123/report.pdf",
    );
  });

  it("keeps each user's document in their own directory", async () => {
    stubDownload(new Uint8Array(Buffer.from("other user's file")));

    const bot = makeBot("files/789/a.txt", "789");
    const result = await filesModule.downloadAndProcessTelegramFile(bot, "user-9", {
      fileId: "789",
      mimeType: "text/plain",
      fileName: "a.txt",
    });

    expect(result.filePath).toBe(path.join(workspaceOf("user-9"), "telegram_files", "a.txt"));
    const written = await fs.readFile(result.filePath!);
    expect(written.toString()).toBe("other user's file");
    await expect(
      fs.access(path.join(workspaceOf("user-1"), "telegram_files", "a.txt")),
    ).rejects.toThrow();
  });

  it("returns base64 image data for image MIME types without writing or uploading a file", async () => {
    const content = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
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
    await expect(fs.access(path.join(workspaceOf("user-1"), "telegram_files"))).rejects.toThrow();
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
      path.join(workspaceOf("user-1"), "telegram_files", ".._.._etc_passwd"),
    );
    await expect(
      fs.readFile(path.join(workspaceOf("user-1"), ".._.._etc_passwd")),
    ).rejects.toThrow();
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
    await expect(fs.access(workspaceOf("user-1"))).rejects.toThrow();
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

  it("propagates a workspace write failure instead of claiming success", async () => {
    stubDownload(new Uint8Array(Buffer.from("data")));
    // A file where the workspace directory should be: every write under it fails.
    await fs.writeFile(workspaceOf("user-1"), "not a directory");

    const bot = makeBot("files/1.pdf", "1");
    await expect(
      filesModule.downloadAndProcessTelegramFile(bot, "user-1", {
        fileId: "1",
        mimeType: "application/pdf",
        fileName: "1.pdf",
      }),
    ).rejects.toThrow(/telegram_files/);
  });
});

// ─── buildFilePromptText ─────────────────────────────────────────────────────

describe("buildFilePromptText", () => {
  it("points the agent at the workspace path for documents", () => {
    const text = filesModule.buildFilePromptText({
      filePath: "/home/u12345678/telegram_files/contract.pdf",
      size: 1234,
      mimeType: "application/pdf",
      fileName: "contract.pdf",
    });

    expect(text).toBe(
      "[File attached: contract.pdf (application/pdf) at /home/u12345678/telegram_files/contract.pdf]",
    );
  });

  it("announces image attachments without a path", () => {
    const text = filesModule.buildFilePromptText({
      imageData: { type: "image", data: "QUJD", mimeType: "image/jpeg" },
      mimeType: "image/jpeg",
      fileName: "screenshot.jpg",
    });

    expect(text).toBe("[Image attached: screenshot.jpg (image/jpeg)]");
  });

  it("leaves the caption to the caller so it is not repeated", () => {
    const text = filesModule.buildFilePromptText({
      imageData: { type: "image", data: "QUJD", mimeType: "image/jpeg" },
      mimeType: "image/jpeg",
      fileName: "screenshot.jpg",
    });

    expect(text).not.toContain("can you review this?");
  });

  it("returns empty string when there is nothing to describe", () => {
    const text = filesModule.buildFilePromptText({ mimeType: "x", fileName: "x" });
    expect(text).toBe("");
  });
});

// ─── sharedFileFromToolCall ──────────────────────────────────────────────────

describe("sharedFileFromToolCall", () => {
  it("names the file when the agent showed one", () => {
    expect(
      filesModule.sharedFileFromToolCall("show_file", {
        filePath: "reports/q3.pdf",
        description: "Quarterly numbers",
      }),
    ).toEqual({ filePath: "reports/q3.pdf", description: "Quarterly numbers" });
  });

  it("ignores every other tool, whatever its arguments look like", () => {
    expect(filesModule.sharedFileFromToolCall("read", { filePath: "secret.txt" })).toBeNull();
    expect(filesModule.sharedFileFromToolCall("bash", { command: "cat secret.txt" })).toBeNull();
  });

  it("needs a usable path", () => {
    expect(filesModule.sharedFileFromToolCall("show_file", { filePath: "" })).toBeNull();
    expect(filesModule.sharedFileFromToolCall("show_file", { filePath: 42 })).toBeNull();
    expect(filesModule.sharedFileFromToolCall("show_file", undefined)).toBeNull();
  });

  it("omits an empty description", () => {
    expect(
      filesModule.sharedFileFromToolCall("show_file", { filePath: "a.txt", description: "" }),
    ).toEqual({ filePath: "a.txt" });
  });
});

// ─── sendSharedFileToTelegram ────────────────────────────────────────────────

describe("sendSharedFileToTelegram", () => {
  const file = {
    fileName: "q3.pdf",
    mimeType: "application/pdf",
    size: 9,
    buffer: new Uint8Array([1, 2, 3]),
  };

  beforeEach(() => {
    mockReadWorkspaceFile.mockResolvedValue(file);
    mockSendTelegramFile.mockResolvedValue(55);
  });

  it("reads the file out of the workspace and uploads it to the chat", async () => {
    await filesModule.sendSharedFileToTelegram({
      userId: "user-1",
      encryptedToken: "tok",
      telegramChatId: BigInt(119075844),
      filePath: "reports/q3.pdf",
      description: "Quarterly numbers",
    });

    expect(mockReadWorkspaceFile).toHaveBeenCalledWith("user-1", "reports/q3.pdf");
    expect(mockSendTelegramFile).toHaveBeenCalledWith("tok", BigInt(119075844), file, {
      caption: "Quarterly numbers",
    });
  });

  it("captions the file with its own name when the agent gave no description", async () => {
    await filesModule.sendSharedFileToTelegram({
      userId: "user-1",
      encryptedToken: "tok",
      telegramChatId: BigInt(1),
      filePath: "reports/q3.pdf",
    });

    expect(mockSendTelegramFile).toHaveBeenCalledWith("tok", BigInt(1), file, {
      caption: "q3.pdf",
    });
  });

  it("logs a failed read instead of throwing into the run", async () => {
    mockReadWorkspaceFile.mockRejectedValue(new Error("Not found: reports/q3.pdf"));

    await expect(
      filesModule.sendSharedFileToTelegram({
        userId: "user-1",
        encryptedToken: "tok",
        telegramChatId: BigInt(1),
        filePath: "reports/q3.pdf",
      }),
    ).resolves.toBeUndefined();

    expect(mockSendTelegramFile).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("reports/q3.pdf"),
      expect.any(Error),
    );
  });

  it("logs a rejected upload instead of throwing into the run", async () => {
    mockSendTelegramFile.mockRejectedValue(new Error("file is too big"));

    await expect(
      filesModule.sendSharedFileToTelegram({
        userId: "user-1",
        encryptedToken: "tok",
        telegramChatId: BigInt(1),
        filePath: "reports/q3.pdf",
      }),
    ).resolves.toBeUndefined();

    expect(consoleErrorSpy).toHaveBeenCalled();
  });
});
