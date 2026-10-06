import { describe, expect, it } from "vitest";

import {
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
  USERNAME_PATTERN,
  isValidUsername,
  normalizeUsername,
} from "@/lib/auth/username";

describe("normalizeUsername", () => {
  it("lowercases and trims", () => {
    expect(normalizeUsername("  Ada.Lovelace ")).toBe("ada.lovelace");
    expect(normalizeUsername("E2E-MOBILE")).toBe("e2e-mobile");
  });

  it("is idempotent", () => {
    const once = normalizeUsername(" Ada_Lovelace-01 ");
    expect(normalizeUsername(once)).toBe(once);
  });
});

describe("isValidUsername", () => {
  it.each([
    "ada",
    "ada.lovelace",
    "ada-lovelace",
    "ada_lovelace",
    "a1.b2-c3_d4",
    "e2e-mobile",
    "user-aaaaaaaaaaaa-12",
    "A".repeat(USERNAME_MAX_LENGTH),
  ])("accepts %j", (username) => {
    expect(isValidUsername(username)).toBe(true);
  });

  it("accepts the raw form a login form sends", () => {
    expect(isValidUsername("  Ada.Lovelace  ")).toBe(true);
  });

  it.each([
    ["too short", "ab"],
    ["too long", "a".repeat(USERNAME_MAX_LENGTH + 1)],
    ["space", "ada lovelace"],
    ["email address", "ada@example.com"],
    ["plus tag", "ada+1"],
    ["accented letter", "adalovelacé"],
    ["slash", "ada/lovelace"],
    ["emoji", "ada🚀"],
    ["empty", ""],
    ["unicode digit", "ada1\u0660"],
  ])("rejects %s", (_label, username) => {
    expect(isValidUsername(username)).toBe(false);
  });

  it("counts length after trimming", () => {
    expect(USERNAME_MIN_LENGTH).toBe(3);
    // Two characters of content, however much padding around them.
    expect(isValidUsername("  ab  ")).toBe(false);
    expect(isValidUsername(" abc ")).toBe(true);
  });

  it("matches exactly the documented character set", () => {
    expect(USERNAME_PATTERN.source).toBe("^[a-z0-9._-]+$");
    for (const char of "abcXYZ019._-") {
      expect(isValidUsername(`ad${char}a`)).toBe(true);
    }
  });
});
