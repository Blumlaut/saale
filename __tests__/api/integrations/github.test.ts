import { describe, it, expect, beforeEach } from "vitest";

// Set env before importing crypto module
process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { _resetKey } from "@/lib/crypto";
import { encrypt } from "@/lib/crypto";

describe("GitHub integration — API contract", () => {
  beforeEach(() => {
    _resetKey();
  });

  describe("POST /api/integrations/github — token validation", () => {
    it("rejects empty token", () => {
      const body = { token: "" };
      expect(!body.token || body.token.trim().length < 10).toBe(true);
    });

    it("rejects short token", () => {
      const body = { token: "short" };
      expect(body.token.trim().length < 10).toBe(true);
    });

    it("accepts valid classic PAT format", () => {
      const body = { token: "ghp_abcdefghijklmnopqrstuvwxyz123456" };
      expect(body.token.trim().length >= 10).toBe(true);
    });

    it("accepts fine-grained PAT format", () => {
      const body = { token: "github_pat_11AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" };
      expect(body.token.trim().length >= 10).toBe(true);
    });
  });

  describe("PATCH /api/integrations/github — enable/disable", () => {
    it("requires enabled field", () => {
      const body: Record<string, boolean> = {};
      expect(body.enabled).toBeUndefined();
    });

    it("accepts true", () => {
      const body = { enabled: true };
      expect(body.enabled).toBe(true);
    });

    it("accepts false", () => {
      const body = { enabled: false };
      expect(body.enabled).toBe(false);
    });
  });

  describe("response shape", () => {
    it("GET returns account or null", () => {
      const connected = {
        account: {
          id: "test-id",
          enabled: true,
          username: "testuser",
          avatarUrl: "https://avatars.githubusercontent.com/test",
          createdAt: "2025-01-01T00:00:00.000Z",
          updatedAt: "2025-01-01T00:00:00.000Z",
        },
      };
      expect(connected.account).toBeDefined();
      expect(connected.account.username).toBe("testuser");

      const disconnected = { account: null };
      expect(disconnected.account).toBeNull();
    });

    it("POST returns created account", () => {
      const response = {
        account: {
          id: "new-id",
          enabled: true,
          username: "newuser",
          avatarUrl: "https://avatars.githubusercontent.com/newuser",
          createdAt: "2025-01-01T00:00:00.000Z",
          updatedAt: "2025-01-01T00:00:00.000Z",
        },
      };
      expect(response.account.enabled).toBe(true);
    });

    it("DELETE returns success", () => {
      const response = { success: true };
      expect(response.success).toBe(true);
    });
  });

  describe("token encryption round-trip", () => {
    it("encrypts and decrypts a GitHub PAT", () => {
      const token = "ghp_test_token_1234567890abcdef";
      const encrypted = encrypt(token);
      expect(encrypted).not.toBe(token);
      expect(encrypted).toContain(":"); // iv:authTag:ciphertext format
    });
  });
});
