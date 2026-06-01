import { describe, it, expect, beforeEach } from "vitest";

// Set env before importing crypto module (64 hex chars = 32 bytes = 256 bits)
process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { encrypt, decrypt, _resetKey } from "@/lib/crypto";

describe("crypto encryption", () => {
  beforeEach(() => {
    _resetKey();
  });

  it("encrypts and decrypts a string correctly", () => {
    const original = "my-secret-password-123";
    const encrypted = encrypt(original);
    const decrypted = decrypt(encrypted);

    expect(encrypted).not.toBe(original);
    expect(decrypted).toBe(original);
  });

  it("produces different ciphertext for same input (IV randomization)", () => {
    const input = "same-input";
    const encrypted1 = encrypt(input);
    const encrypted2 = encrypt(input);

    expect(encrypted1).not.toBe(encrypted2);
    expect(decrypt(encrypted1)).toBe(input);
    expect(decrypt(encrypted2)).toBe(input);
  });

  it("handles empty string", () => {
    const encrypted = encrypt("");
    const decrypted = decrypt(encrypted);
    expect(decrypted).toBe("");
  });

  it("handles unicode characters", () => {
    const input = "Hello 世界 🌍 Привет";
    const encrypted = encrypt(input);
    const decrypted = decrypt(encrypted);
    expect(decrypted).toBe(input);
  });

  it("handles long strings", () => {
    const input = "a".repeat(10000);
    const encrypted = encrypt(input);
    const decrypted = decrypt(encrypted);
    expect(decrypted).toBe(input);
  });

  it("throws on invalid format", () => {
    expect(() => decrypt("invalid-format")).toThrow("Invalid encrypted data format");
  });
});
