import { describe, expect, it } from "vitest";
import {
  councilIdentity,
  InvalidSandboxIdentityError,
  isSandboxIdentity,
  parseIdentity,
  userIdentity,
} from "@/lib/sandbox/identity";

describe("parseIdentity", () => {
  it("accepts the two shapes the app produces", () => {
    expect(parseIdentity("user-abc123")).toBe("user-abc123");
    expect(parseIdentity("council-abcd1234")).toBe("council-abcd1234");
  });

  it("refuses anything a caller might use to name another tree", () => {
    const rejected: unknown[] = [
      "user-",
      "user",
      "user-abc/../user-other",
      "user-../../etc",
      "council-abc/def",
      "user-abc\0",
      "/workspaces/user-abc",
      "user-abc\n",
      "admin-abc",
      "user-" + "a".repeat(65),
      null,
      undefined,
      42,
      { identity: "user-abc" },
    ];
    for (const raw of rejected) {
      expect(() => parseIdentity(raw)).toThrow(InvalidSandboxIdentityError);
      expect(isSandboxIdentity(raw)).toBe(false);
    }
  });

  it("refuses a path, whatever it contains", () => {
    expect(isSandboxIdentity("../user-abc")).toBe(false);
    expect(isSandboxIdentity("user-abc/")).toBe(false);
  });
});

describe("userIdentity / councilIdentity", () => {
  it("prefixes the id so a user and a council can never collide", () => {
    expect(userIdentity("abc123")).toBe("user-abc123");
    expect(councilIdentity("abc123")).toBe("council-abc123");
  });

  it("refuses an id the pattern cannot carry", () => {
    expect(() => userIdentity("bad id")).toThrow(InvalidSandboxIdentityError);
    expect(() => councilIdentity("../escape")).toThrow(InvalidSandboxIdentityError);
  });
});
