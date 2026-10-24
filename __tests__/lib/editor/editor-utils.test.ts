import { describe, expect, it } from "vitest";
import {
  basenameOf,
  isBinaryFile,
  languageFromPath,
  previewKindFromPath,
} from "@/lib/editor/editor-utils";

describe("languageFromPath", () => {
  it("maps common extensions to Monaco ids", () => {
    expect(languageFromPath("src/app.ts")).toBe("typescript");
    expect(languageFromPath("README.md")).toBe("markdown");
    expect(languageFromPath("infra/Dockerfile")).toBe("dockerfile");
  });

  it("returns nothing for unknown and extensionless paths", () => {
    expect(languageFromPath("Makefile")).toBe("");
    expect(languageFromPath("weird.unknownext")).toBe("");
    expect(languageFromPath(".env.local")).toBe("");
  });
});

describe("previewKindFromPath", () => {
  it("names the previewable kinds", () => {
    expect(previewKindFromPath("docs/readme.md")).toBe("markdown");
    expect(previewKindFromPath("public/page.html")).toBe("html");
    expect(previewKindFromPath("assets/logo.png")).toBe("image");
    expect(previewKindFromPath("media/demo.mp4")).toBe("video");
  });

  it("returns nothing for text and binary files alike", () => {
    expect(previewKindFromPath("src/app.ts")).toBeNull();
    expect(previewKindFromPath("assets/font.ttf")).toBeNull();
  });
});

describe("isBinaryFile", () => {
  it("matches the media and archive extensions", () => {
    expect(isBinaryFile("image.png")).toBe(true);
    expect(isBinaryFile("archive.zip")).toBe(true);
    expect(isBinaryFile("font.ttf")).toBe(true);
  });

  it("keeps SVG text-shaped", () => {
    expect(isBinaryFile("logo.svg")).toBe(false);
  });

  it("leaves text and unknown extensions alone", () => {
    expect(isBinaryFile("script.ts")).toBe(false);
    expect(isBinaryFile("data.xyz")).toBe(false);
  });
});

describe("basenameOf", () => {
  it("keeps a leading dot", () => {
    expect(basenameOf("src/app.ts")).toBe("app.ts");
    expect(basenameOf(".env.local")).toBe(".env.local");
  });
});
