// Set env before importing crypto module
process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { describe, it, expect, beforeEach } from "vitest";
import { _resetKey } from "@/lib/crypto";
import { encrypt, decrypt } from "@/lib/crypto";

describe("GitHub integration  crypto", () => {
  beforeEach(() => {
    _resetKey();
  });

  it("encrypts and decrypts a GitHub PAT", () => {
    const token = "ghp_test_token_1234567890abcdef";
    const encrypted = encrypt(token);
    expect(encrypted).not.toBe(token);
    expect(decrypt(encrypted)).toBe(token);
  });

  it("encrypts different tokens to different values", () => {
    const token1 = "ghp_abcdefghijklmnopqrstuvwxyz123456";
    const token2 = "github_pat_11AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    expect(encrypt(token1)).not.toBe(encrypt(token2));
  });
});
