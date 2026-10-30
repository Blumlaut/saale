import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import fs from "fs/promises";
import os from "os";
import path from "path";
import sharp from "sharp";
import { userIdentity } from "@/lib/sandbox/identity";

let attachmentsModule: typeof import("@/lib/file-attachment");
let errorsModule: typeof import("@/lib/files/errors");
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
  userRoot = path.join(tmpRoot, userIdentity("user-1"));
  vi.resetModules();
  attachmentsModule = await import("@/lib/file-attachment");
  errorsModule = await import("@/lib/files/errors");
});

afterAll(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await fs.rm(userRoot, { recursive: true, force: true });
});

/** Leave bytes where the upload chunks would have, and name them. */
async function stage(bytes: Buffer): Promise<string> {
  const uploadId = randomUUID();
  const staging = path.join(userRoot, ".tmp");
  await fs.mkdir(staging, { recursive: true });
  await fs.writeFile(path.join(staging, `upload-${uploadId}`), bytes);
  return uploadId;
}

function ref(uploadId: string, fileName: string, mimeType: string, size: number) {
  return { uploadId, fileName, mimeType, size };
}

// ─── validateChatAttachment ──────────────────────────────────────────────────

describe("validateChatAttachment", () => {
  it("accepts arbitrary MIME types", () => {
    for (const type of ["application/pdf", "application/zip", "text/csv", ""]) {
      expect(attachmentsModule.validateChatAttachment(ref("u", "doc.bin", type, 3))).toBeNull();
    }
  });

  it("rejects empty files", () => {
    expect(
      attachmentsModule.validateChatAttachment(ref("u", "empty.pdf", "application/pdf", 0)),
    ).toBe("File is empty");
  });

  it("caps images at 15MB and other files at 250MB", () => {
    const image = attachmentsModule.MAX_CHAT_IMAGE_BYTES + 1;
    expect(
      attachmentsModule.validateChatAttachment(ref("u", "big.png", "image/png", image)),
    ).toMatch(/File too large/);

    const file = attachmentsModule.MAX_CHAT_FILE_BYTES + 1;
    expect(
      attachmentsModule.validateChatAttachment(ref("u", "big.zip", "application/zip", file)),
    ).toMatch(/File too large/);

    expect(
      attachmentsModule.validateChatAttachment(
        ref("u", "big.zip", "application/zip", attachmentsModule.MAX_CHAT_FILE_BYTES),
      ),
    ).toBeNull();
  });
});

// ─── adoptChatUpload ─────────────────────────────────────────────────────────

describe("adoptChatUpload", () => {
  it("moves a non-image into files/ and copies it to uploads/", async () => {
    const content = Buffer.from("%PDF-1.4 fake pdf body");
    const uploadId = await stage(content);

    const result = await attachmentsModule.adoptChatUpload(
      "user-1",
      ref(uploadId, "report.pdf", "application/pdf", content.length),
    );

    expect(result.stored.storagePath).toMatch(/^files\/[0-9a-f-]{36}-report\.pdf$/);
    expect(result.stored.safeName).toBe("report.pdf");
    expect(result.stored.width).toBeUndefined();
    expect(result.agentPath).toBe(path.join(userRoot, "uploads", "report.pdf"));

    // The bytes the user sent are the bytes both copies hold.
    expect(await fs.readFile(path.join(userRoot, result.stored.storagePath))).toEqual(content);
    expect(await fs.readFile(result.agentPath)).toEqual(content);

    // The staged copy is gone: the file was moved, not duplicated.
    await expect(fs.access(path.join(userRoot, ".tmp", `upload-${uploadId}`))).rejects.toThrow();
  });

  it("re-encodes an image and keeps the original bytes for the agent", async () => {
    const uploadId = await stage(TINY_PNG);

    const result = await attachmentsModule.adoptChatUpload(
      "user-1",
      ref(uploadId, "photo.png", "image/png", TINY_PNG.length),
    );

    expect(result.stored.storagePath).toMatch(/^images\/[0-9a-f-]{36}\.png$/);
    expect(result.stored.width).toBe(1);
    expect(result.stored.height).toBe(1);
    expect(await fs.readFile(result.agentPath)).toEqual(TINY_PNG);
    expect(
      (await fs.readFile(path.join(userRoot, result.stored.storagePath))).length,
    ).toBeGreaterThan(0);
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

    const uploadId = await stage(phonePhoto);
    const result = await attachmentsModule.adoptChatUpload(
      "user-1",
      ref(uploadId, "phone-photo.jpg", "image/jpeg", phonePhoto.length),
    );

    // 100x50 landscape pixels + orientation 6 → 50x100 portrait output
    expect(result.stored.width).toBe(50);
    expect(result.stored.height).toBe(100);

    // Content check: rotating 90° clockwise puts the red left half on top
    // and the blue right half on the bottom.
    const out = await sharp(path.join(userRoot, result.stored.storagePath))
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
    const first = await stage(Buffer.from("one"));
    const second = await stage(Buffer.from("two"));

    const a = await attachmentsModule.adoptChatUpload(
      "user-1",
      ref(first, "x.txt", "text/plain", 3),
    );
    const b = await attachmentsModule.adoptChatUpload(
      "user-1",
      ref(second, "x.txt", "text/plain", 3),
    );
    expect(a.stored.storagePath).not.toBe(b.stored.storagePath);
  });

  it("sanitizes hostile file names before writing", async () => {
    const uploadId = await stage(Buffer.from("data"));

    const result = await attachmentsModule.adoptChatUpload(
      "user-1",
      ref(uploadId, "../../secret/evil.txt", "text/plain", 4),
    );

    expect(result.stored.safeName).toBe("evil.txt");
    // The file must land inside the user directory, never outside it.
    const full = path.join(userRoot, result.stored.storagePath);
    expect(full.startsWith(tmpRoot + path.sep)).toBe(true);
    expect(await fs.readFile(full, "utf8")).toBe("data");
  });

  it("refuses an upload that is not staged", async () => {
    await expect(
      attachmentsModule.adoptChatUpload("user-1", ref(randomUUID(), "gone.txt", "text/plain", 4)),
    ).rejects.toBeInstanceOf(errorsModule.FileNotFoundError);
  });

  it("refuses a file that arrived short", async () => {
    const uploadId = await stage(Buffer.from("abc"));

    await expect(
      attachmentsModule.adoptChatUpload("user-1", ref(uploadId, "short.txt", "text/plain", 10)),
    ).rejects.toBeInstanceOf(errorsModule.FileUploadError);
  });

  it("refuses an upload id that was not issued", async () => {
    await expect(
      attachmentsModule.adoptChatUpload("user-1", ref("../../etc/passwd", "x", "text/plain", 1)),
    ).rejects.toBeInstanceOf(errorsModule.FileNotFoundError);
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
