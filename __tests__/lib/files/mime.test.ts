import { describe, expect, it } from "vitest";

import { extensionOf, mimeTypeForName, previewKindFor } from "@/lib/files/mime";

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
