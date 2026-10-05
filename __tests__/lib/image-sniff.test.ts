import { describe, it, expect } from "vitest";
import { detectImageMimeTypeFromBuffer, IMAGE_SNIFF_BYTES } from "@/lib/image-sniff";

/** 1x1 PNG, the same fixture the attachment tests use. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

/** A minimal WebP header: "RIFF" + 4-byte size + "WEBP". */
function webpHeader(): Buffer {
  const buffer = Buffer.alloc(16);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(4, 4);
  buffer.write("WEBP", 8, "ascii");
  return buffer;
}

describe("detectImageMimeTypeFromBuffer", () => {
  it("detects a PNG from its signature", () => {
    expect(detectImageMimeTypeFromBuffer(PNG)).toBe("image/png");
  });

  it("detects JPEG", () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    expect(detectImageMimeTypeFromBuffer(jpeg)).toBe("image/jpeg");
  });

  it("rejects the JPEG variant that means lossless JPEG", () => {
    const lossless = Buffer.from([0xff, 0xd8, 0xff, 0xf7, 0x00]);
    expect(detectImageMimeTypeFromBuffer(lossless)).toBeNull();
  });

  it("detects GIF87a and GIF89a", () => {
    expect(detectImageMimeTypeFromBuffer(Buffer.from("GIF87a....", "ascii"))).toBe("image/gif");
    expect(detectImageMimeTypeFromBuffer(Buffer.from("GIF89a....", "ascii"))).toBe("image/gif");
  });

  it("detects WebP", () => {
    expect(detectImageMimeTypeFromBuffer(webpHeader())).toBe("image/webp");
  });

  it("returns null for text files", () => {
    expect(detectImageMimeTypeFromBuffer(Buffer.from("server {\n  listen 80;\n}\n", "utf8"))).toBe(
      null,
    );
    expect(detectImageMimeTypeFromBuffer(Buffer.from("RIFF but not webp", "ascii"))).toBeNull();
  });

  it("returns null rather than throwing on short or empty input", () => {
    expect(detectImageMimeTypeFromBuffer(Buffer.alloc(0))).toBeNull();
    expect(detectImageMimeTypeFromBuffer(Buffer.from([0xff, 0xd8]))).toBeNull();
    expect(detectImageMimeTypeFromBuffer(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
  });

  it("rejects a PNG signature whose first chunk is not IHDR", () => {
    const bogus = Buffer.from(PNG);
    bogus.write("IDAT", 12, "ascii");
    expect(detectImageMimeTypeFromBuffer(bogus)).toBeNull();
  });

  it("detects the header from a buffer trimmed to the sniff size", () => {
    const head = PNG.subarray(0, IMAGE_SNIFF_BYTES);
    expect(detectImageMimeTypeFromBuffer(head)).toBe("image/png");
  });
});
