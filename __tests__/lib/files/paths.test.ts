import { describe, expect, it } from "vitest";
import { FilePathEscapeError } from "@/lib/files/errors";
import {
  baseName,
  dirName,
  isSafeEntryName,
  isWithinRoot,
  relativeToRoot,
  requireWithinRoot,
  resolveWithinRoot,
} from "@/lib/files/paths";

const ROOT = "/home/u1a2b3c4";

describe("resolveWithinRoot", () => {
  it("resolves a relative path against the root", () => {
    expect(resolveWithinRoot(ROOT, "notes/plan.md")).toEqual({
      path: `${ROOT}/notes/plan.md`,
      inside: true,
    });
  });

  it("keeps an absolute path that is already inside", () => {
    expect(resolveWithinRoot(ROOT, `${ROOT}/a.txt`).path).toBe(`${ROOT}/a.txt`);
  });

  it("collapses the noise a shell or a careless client adds", () => {
    expect(resolveWithinRoot(ROOT, "./a//b/../c").path).toBe(`${ROOT}/a/c`);
    expect(resolveWithinRoot(ROOT, "/").path).toBe(ROOT);
  });

  it("accepts the root itself", () => {
    expect(resolveWithinRoot(ROOT, ROOT)).toEqual({ path: ROOT, inside: true });
  });

  it("refuses a climb above the root", () => {
    expect(resolveWithinRoot(ROOT, "../etc/passwd").inside).toBe(false);
    expect(resolveWithinRoot(ROOT, "a/../../etc/passwd").inside).toBe(false);
    expect(resolveWithinRoot(ROOT, "/etc/passwd").inside).toBe(false);
  });

  it("refuses a sibling that merely shares the prefix", () => {
    // The bug a bare `startsWith(root)` would let through: /home/u1a2b3c4-secrets.
    const sibling = `${ROOT}-secrets/key`;
    expect(resolveWithinRoot(ROOT, sibling).inside).toBe(false);
    expect(isWithinRoot(ROOT, sibling)).toBe(false);
  });

  it("refuses a NUL byte rather than letting a syscall truncate the path", () => {
    expect(resolveWithinRoot(ROOT, `${ROOT}/a\0.txt`).inside).toBe(false);
  });

  it("handles a root with a trailing separator", () => {
    expect(resolveWithinRoot(`${ROOT}/`, "a.txt").path).toBe(`${ROOT}/a.txt`);
  });
});

describe("requireWithinRoot", () => {
  it("returns the resolved path when it is inside", () => {
    expect(requireWithinRoot(ROOT, "docs/readme.md")).toBe(`${ROOT}/docs/readme.md`);
  });

  it("throws for an escape", () => {
    expect(() => requireWithinRoot(ROOT, "../other")).toThrow(FilePathEscapeError);
    expect(() => requireWithinRoot(ROOT, "/etc/shadow")).toThrow(FilePathEscapeError);
  });
});

describe("relativeToRoot", () => {
  it("expresses a path relative to the root", () => {
    expect(relativeToRoot(ROOT, `${ROOT}/a/b.txt`)).toBe("a/b.txt");
    expect(relativeToRoot(ROOT, ROOT)).toBe("");
  });

  it("returns null outside the root, so no zip entry can climb out", () => {
    expect(relativeToRoot(ROOT, `${ROOT}-secrets/a`)).toBeNull();
    expect(relativeToRoot(ROOT, "/etc/passwd")).toBeNull();
  });
});

describe("name helpers", () => {
  it("splits a path into a name and its parent", () => {
    expect(baseName(`${ROOT}/a/b.txt`)).toBe("b.txt");
    expect(dirName(`${ROOT}/a/b.txt`)).toBe(`${ROOT}/a`);
    expect(baseName(ROOT)).toBe("u1a2b3c4");
    expect(dirName("/top")).toBe("/");
  });

  it("accepts a plain name and refuses anything that is a path", () => {
    expect(isSafeEntryName("report (final).md")).toBe(true);
    expect(isSafeEntryName(".env")).toBe(true);
    for (const bad of ["", ".", "..", "a/b", "a\\b", "a\0b", "x".repeat(256)]) {
      expect(isSafeEntryName(bad), bad).toBe(false);
    }
  });
});
