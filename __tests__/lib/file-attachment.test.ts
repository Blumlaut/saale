import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import sharp from "sharp";

let attachmentsModule: typeof import("@/lib/file-attachment");
let tmpRoot: string;
/** The user's workspace, `<workspaces>/user-<id>`. */
let userRoot: string;

/** A minimal valid 1x1 PNG. */
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "saale-chat-files-"));
  vi.stubEnv("SANDBOX_WORKSPACES_DIR", tmpRoot);
  vi.stubEnv("SANDBOX_USER", "root");
  userRoot = path.join(tmpRoot, "user-user-1");
  vi.resetModules();
  attachmentsModule = await import("@/lib/file-attachment");
});

afterAll(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await fs.rm(userRoot, { recursive: true, force: true });
});

// ─── validateChatFile ────────────────────────────────────────────────────────

describe("validateChatFile", () => {
  it("accepts arbitrary MIME types", () => {
    for (const type of ["application/pdf", "application/zip", "text/csv", ""]) {
      const file = new File([new Uint8Array([1, 2, 3])], "doc.bin", { type });
      expect(attachmentsModule.validateChatFile(file)).toBeNull();
    }
  });

  it("rejects empty files", () => {
    const file = new File([], "empty.pdf", { type: "application/pdf" });
    expect(attachmentsModule.validateChatFile(file)).toBe("File is empty");
  });

  it("rejects files over the 15MB limit", () => {
    const oversized = new File([new Uint8Array(15 * 1024 * 1024 + 1)], "big.bin");
    expect(attachmentsModule.validateChatFile(oversized)).toMatch(/File too large/);
  });
});

// ─── sanitizeFileName ────────────────────────────────────────────────────────

describe("sanitizeFileName", () => {
  it("strips directory traversal", () => {
    expect(attachmentsModule.sanitizeFileName("../../etc/passwd")).toBe("passwd");
  });

  it("replaces unsafe characters", () => {
    expect(attachmentsModule.sanitizeFileName("my report.pdf")).toBe("my_report.pdf");
    expect(attachmentsModule.sanitizeFileName("weird\u00e9 file.txt")).toBe("weird__file.txt");
  });

  it("falls back to 'file' for empty or dot-only names", () => {
    expect(attachmentsModule.sanitizeFileName("....")).toBe("file");
    expect(attachmentsModule.sanitizeFileName("/")).toBe("file");
  });
});

// ─── storeChatFile ───────────────────────────────────────────────────────────

describe("storeChatFile", () => {
  it("stores non-image files as original bytes under files/ with a unique prefix", async () => {
    const content = Buffer.from("%PDF-1.4 fake pdf body");
    const result = await attachmentsModule.storeChatFile(
      "user-1",
      content,
      "report.pdf",
      "application/pdf",
    );

    expect(result.storagePath).toMatch(/^files\/[0-9a-f-]{36}-report\.pdf$/);
    expect(result.safeName).toBe("report.pdf");
    expect(result.width).toBeUndefined();
    expect(result.height).toBeUndefined();

    const onDisk = await fs.readFile(path.join(userRoot, result.storagePath));
    expect(onDisk.equals(content)).toBe(true);
  });

  it("re-encodes images via the existing sharp pipeline", async () => {
    const result = await attachmentsModule.storeChatFile(
      "user-1",
      TINY_PNG,
      "photo.png",
      "image/png",
    );

    expect(result.storagePath).toMatch(/^images\/[0-9a-f-]{36}\.png$/);
    expect(result.safeName).toBe("photo.png");
    expect(result.width).toBe(1);
    expect(result.height).toBe(1);

    const onDisk = await fs.readFile(path.join(userRoot, result.storagePath));
    expect(onDisk.length).toBeGreaterThan(0);
  });

  it("bakes EXIF orientation into stored pixels so portrait phone photos stay portrait", async () => {
    // Phones store raw landscape pixels plus an EXIF orientation tag
    // (6 = display rotated 90° clockwise). The stored PNG must be the
    // portrait image the user actually saw.
    const rightHalf = await sharp({
      create: { width: 50, height: 50, channels: 3, background: "#0000ff" },
    })
      .png()
      .toBuffer();
    const phonePhoto = await sharp({
      create: { width: 100, height: 50, channels: 3, background: "#ff0000" },
    })
      .composite([{ input: rightHalf, left: 50, top: 0 }])
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();

    const result = await attachmentsModule.storeChatFile(
      "user-1",
      phonePhoto,
      "phone-photo.jpg",
      "image/jpeg",
    );

    // 100x50 landscape pixels + orientation 6 → 50x100 portrait output
    expect(result.width).toBe(50);
    expect(result.height).toBe(100);

    // Content check: rotating 90° clockwise puts the red left half on top
    // and the blue right half on the bottom.
    const out = await sharp(path.join(userRoot, result.storagePath))
      .raw()
      .toBuffer({ resolveWithObject: true });
    const pixel = (x: number, y: number) => {
      const i = (y * out.info.width + x) * out.info.channels;
      return [out.data[i]!, out.data[i + 1]!, out.data[i + 2]!];
    };
    const [topR, topG] = pixel(10, 10);
    const [, , bottomB] = pixel(10, 90);
    expect(topR).toBeGreaterThan(200);
    expect(topG).toBeLessThan(60);
    expect(bottomB).toBeGreaterThan(200);
  });

  it("never collides when the same name is uploaded twice", async () => {
    const a = await attachmentsModule.storeChatFile(
      "user-1",
      Buffer.from("one"),
      "x.txt",
      "text/plain",
    );
    const b = await attachmentsModule.storeChatFile(
      "user-1",
      Buffer.from("two"),
      "x.txt",
      "text/plain",
    );
    expect(a.storagePath).not.toBe(b.storagePath);
  });

  it("sanitizes hostile file names before writing", async () => {
    const result = await attachmentsModule.storeChatFile(
      "user-1",
      Buffer.from("data"),
      "../../secret/evil.txt",
      "text/plain",
    );
    expect(result.safeName).toBe("evil.txt");
    // The file must land inside the user directory, never outside it.
    const full = path.join(userRoot, result.storagePath);
    expect(full.startsWith(tmpRoot + path.sep)).toBe(true);
    expect(await fs.readFile(full, "utf8")).toBe("data");
  });
});

// ─── deliverChatFileToAgent ──────────────────────────────────────────────────

describe("deliverChatFileToAgent", () => {
  it("copies the file into uploads/ under the name the user gave it", async () => {
    const result = await attachmentsModule.deliverChatFileToAgent(
      "user-1",
      Buffer.from("pdf-bytes"),
      "report.pdf",
    );

    expect(result).toBe(path.join(userRoot, "uploads", "report.pdf"));
    expect(await fs.readFile(result, "utf8")).toBe("pdf-bytes");
  });

  it("creates uploads/ for a workspace that has nothing in it yet", async () => {
    await fs.rm(userRoot, { recursive: true, force: true });

    const result = await attachmentsModule.deliverChatFileToAgent(
      "user-1",
      Buffer.from("x"),
      "x.txt",
    );

    expect(await fs.readFile(result, "utf8")).toBe("x");
  });

  it("refuses a name that tries to leave the workspace", async () => {
    await expect(
      attachmentsModule.deliverChatFileToAgent("user-1", Buffer.from("x"), "../../user-2/x.txt"),
    ).rejects.toThrow(/outside the workspace/);
  });
});

// ─── buildAttachmentPromptText ───────────────────────────────────────────────

describe("buildAttachmentPromptText", () => {
  it("builds a path reference line for a file attachment", () => {
    const text = attachmentsModule.buildAttachmentPromptText([
      {
        fileName: "report.pdf",
        mimeType: "application/pdf",
        agentPath: "/home/user123/uploads/report.pdf",
      },
    ]);
    expect(text).toBe(
      "[File attached: report.pdf (application/pdf) at /home/user123/uploads/report.pdf]",
    );
  });

  it("labels image attachments as Image", () => {
    const text = attachmentsModule.buildAttachmentPromptText([
      { fileName: "photo.png", mimeType: "image/png", agentPath: "/home/u/uploads/photo.png" },
    ]);
    expect(text).toBe("[Image attached: photo.png (image/png) at /home/u/uploads/photo.png]");
  });

  it("omits the path segment when the file was not delivered to the agent", () => {
    const text = attachmentsModule.buildAttachmentPromptText([
      { fileName: "data.csv", mimeType: "text/csv", agentPath: null },
    ]);
    expect(text).toBe("[File attached: data.csv (text/csv)]");
  });

  it("joins multiple attachments with newlines", () => {
    const text = attachmentsModule.buildAttachmentPromptText([
      { fileName: "a.pdf", mimeType: "application/pdf", agentPath: "/h/u/uploads/a.pdf" },
      { fileName: "b.png", mimeType: "image/png", agentPath: "/h/u/uploads/b.png" },
    ]);
    expect(text.split("\n")).toHaveLength(2);
    expect(text).toContain("a.pdf");
    expect(text).toContain("b.png");
  });
});

// ─── stripAttachmentPromptText ───────────────────────────────────────────────

describe("stripAttachmentPromptText", () => {
  it("removes a single image line and keeps the user text", () => {
    const content =
      "invert the colours\n[Image attached: shot.png (image/png) at /home/u/uploads/shot.png]";
    expect(attachmentsModule.stripAttachmentPromptText(content)).toBe("invert the colours");
  });

  it("removes every attachment line across multiple files", () => {
    const content = [
      "do a thing",
      "[File attached: report.pdf (application/pdf) at /home/u/uploads/report.pdf]",
      "[Image attached: shot.png (image/png)]",
    ].join("\n");
    expect(attachmentsModule.stripAttachmentPromptText(content)).toBe("do a thing");
  });

  it("returns an empty string when the content is only attachment lines", () => {
    const content = "[Image attached: shot.png (image/png) at /home/u/uploads/shot.png]";
    expect(attachmentsModule.stripAttachmentPromptText(content)).toBe("");
  });

  it("leaves content without attachment lines unchanged (except surrounding trim)", () => {
    const content = "just plain text\nwith two lines";
    expect(attachmentsModule.stripAttachmentPromptText(content)).toBe(content);
  });

  it("only strips lines that are exactly an attachment reference", () => {
    const content = "see [Image attached: real] in the notes\n[File attached: a.pdf (x)]";
    expect(attachmentsModule.stripAttachmentPromptText(content)).toBe(
      "see [Image attached: real] in the notes",
    );
  });
});
