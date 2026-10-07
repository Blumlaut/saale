import { describe, it, expect, afterEach } from "vitest";
import path from "node:path";
import { getUploadsDir } from "@/lib/uploads";

describe("getUploadsDir", () => {
  const original = process.env.UPLOADS_DIR;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.UPLOADS_DIR;
    } else {
      process.env.UPLOADS_DIR = original;
    }
  });

  it("defaults to an absolute <cwd>/uploads path when UPLOADS_DIR is unset", () => {
    delete process.env.UPLOADS_DIR;
    expect(getUploadsDir()).toBe(path.join(process.cwd(), "uploads"));
  });

  it("returns UPLOADS_DIR verbatim when set", () => {
    process.env.UPLOADS_DIR = "/app/uploads";
    expect(getUploadsDir()).toBe("/app/uploads");
  });
});
