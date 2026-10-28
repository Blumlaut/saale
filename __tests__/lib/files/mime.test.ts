import { describe, expect, it } from "vitest";

import { extensionOf, looksBinary, mimeTypeForName, previewKindFor } from "@/lib/files/mime";

describe("extensionOf", () => {
  it("reads a trailing extension, lowercased", () => {
    expect(extensionOf("notes.md")).toBe(".md");
    expect(extensionOf("Photo.PNG")).toBe(".png");
    expect(extensionOf("archive.tar.gz")).toBe(".gz");
  });

  it("gives a dotfile and a bare name no extension", () => {
    // A leading dot names the file; it does not type it.
    expect(extensionOf(".gitconfig")).toBe("");
    expect(extensionOf("Makefile")).toBe("");
    expect(extensionOf(".env.local")).toBe(".local");
  });
});

describe("mimeTypeForName", () => {
  it("types what it knows and falls back to octet-stream", () => {
    expect(mimeTypeForName("notes.md")).toBe("text/markdown");
    expect(mimeTypeForName(".gitconfig")).toBe("application/octet-stream");
    expect(mimeTypeForName("thing.zzz")).toBe("application/octet-stream");
  });
});

describe("previewKindFor", () => {
  it("shows config files as text, extension or not", () => {
    expect(previewKindFor(".gitconfig", mimeTypeForName(".gitconfig"))).toBe("text");
    expect(previewKindFor("Makefile", mimeTypeForName("Makefile"))).toBe("text");
    expect(previewKindFor(".env.local", mimeTypeForName(".env.local"))).toBe("text");
    expect(previewKindFor("thing.zzz", mimeTypeForName("thing.zzz"))).toBe("text");
  });

  it("keeps media and archives out of the text view", () => {
    expect(previewKindFor("logo.png", mimeTypeForName("logo.png"))).toBe("image");
    expect(previewKindFor("clip.mp4", mimeTypeForName("clip.mp4"))).toBe("binary");
    expect(previewKindFor("archive.zip", mimeTypeForName("archive.zip"))).toBe("binary");
    // SVG is source, not an image: an inline SVG document can carry script.
    expect(previewKindFor("logo.svg", mimeTypeForName("logo.svg"))).toBe("text");
  });
});

describe("looksBinary", () => {
  it("accepts utf-8 text, and a sample cut mid-character", () => {
    const encoder = new TextEncoder();
    expect(looksBinary(encoder.encode("# notes\n"))).toBe(false);
    expect(looksBinary(encoder.encode("héllo 🌍\n"))).toBe(false);
    // The first two bytes of an emoji: incomplete, not invalid.
    expect(looksBinary(new Uint8Array([0xf0, 0x9f, 0x8c]))).toBe(false);
  });

  it("refuses a NUL byte and bytes that are not utf-8 at all", () => {
    expect(looksBinary(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01]))).toBe(true);
    // A PDF's opening bytes hold no NUL and are still not text.
    expect(looksBinary(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0xe2, 0xe3, 0xcf]))).toBe(true);
  });
});
