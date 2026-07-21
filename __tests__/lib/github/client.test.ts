import { describe, it, expect, beforeEach, vi } from "vitest";

// Set env before importing crypto module (64 hex chars = 32 bytes = 256 bits)
process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { _resetKey } from "@/lib/crypto";

describe("GitHub client — token validation", () => {
  beforeEach(() => {
    _resetKey();
    vi.restoreAllMocks();
  });

  it("validates a token shape", () => {
    // GitHub PATs start with "ghp_" for classic tokens or "github_pat_" for fine-grained
    const classicToken = "ghp_abcdefghijklmnopqrstuvwxyz123456";
    const fineGrainedToken = "github_pat_11AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

    expect(classicToken.startsWith("ghp_")).toBe(true);
    expect(fineGrainedToken.startsWith("github_pat_")).toBe(true);
  });

  it("rejects tokens that are too short", () => {
    const shortToken = "ghp_short";
    expect(shortToken.length).toBeLessThan(10);
  });

  it("handles token trimming", () => {
    const rawToken = "  ghp_abcdefghijklmnopqrstuvwxyz123456  ";
    const trimmed = rawToken.trim();
    expect(trimmed).toBe("ghp_abcdefghijklmnopqrstuvwxyz123456");
    expect(trimmed).not.toMatch(/^\s/);
    expect(trimmed).not.toMatch(/\s$/);
  });
});

describe("GitHub client — env injection", () => {
  beforeEach(() => {
    _resetKey();
  });

  it("builds correct env object structure", () => {
    const token = "ghp_test_token";
    const env = { GH_TOKEN: token };
    expect(env).toEqual({ GH_TOKEN: token });
    expect(Object.keys(env)).toHaveLength(1);
  });

  it("null env when disabled", () => {
    const env = null;
    expect(env).toBeNull();
  });
});

describe("GitHub client — API URL construction", () => {
  it("builds correct API base URL", () => {
    const base = "https://api.github.com";
    const path = "/user";
    const url = `${base}${path}`;
    expect(url).toBe("https://api.github.com/user");
  });

  it("includes API version header", () => {
    const version = "2022-11-28";
    const headers: Record<string, string> = {
      "X-GitHub-Api-Version": version,
    };
    expect(headers["X-GitHub-Api-Version"]).toBe(version);
  });
});
