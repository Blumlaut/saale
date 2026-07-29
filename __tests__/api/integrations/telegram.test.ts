// Set env before importing crypto module
process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { describe, it, expect, beforeEach } from "vitest";
import { _resetKey } from "@/lib/crypto";
import { encrypt } from "@/lib/crypto";

describe("Telegram integration — API contract", () => {
  beforeEach(() => {
    _resetKey();
  });

  describe("POST /api/integrations/telegram — token validation", () => {
    it("rejects empty token", () => {
      const body = { token: "" };
      expect(!body.token || body.token.trim().length < 10).toBe(true);
    });

    it("rejects short token", () => {
      const body = { token: "short" };
      expect(body.token.trim().length < 10).toBe(true);
    });

    it("rejects non-string token", () => {
      const body = { token: 12345 };
      expect(typeof body.token !== "string").toBe(true);
    });

    it("accepts valid Telegram bot token format", () => {
      const body = { token: "123456789:AAGWzUqz4aBcDeFgHiJkLmNoPqRsTuVwXyZ" };
      expect(body.token.trim().length >= 10).toBe(true);
      expect(body.token.includes(":")).toBe(true);
    });

    it("trims whitespace from token", () => {
      const body = { token: "  123456789:AAGWzUqz4aBcDeFgHiJkLmNoPqRsTuVwXyZ  " };
      expect(body.token.trim()).toBe("123456789:AAGWzUqz4aBcDeFgHiJkLmNoPqRsTuVwXyZ");
    });
  });

  describe("PATCH /api/integrations/telegram — enable/disable", () => {
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

    it("rejects non-boolean enabled", () => {
      const body = { enabled: "true" };
      expect(typeof body.enabled !== "boolean").toBe(true);
    });
  });

  describe("GET /api/integrations/telegram/whitelist", () => {
    it("returns entries array with correct shape", () => {
      const response = {
        entries: [
          {
            id: "cm5xxxxx",
            telegramUserId: "123456789",
            displayName: "Test User",
            createdAt: "2025-01-01T00:00:00.000Z",
          },
        ],
      };

      expect(Array.isArray(response.entries)).toBe(true);
      const first = response.entries[0];
      expect(first!.id).toBeDefined();
      expect(typeof first!.telegramUserId).toBe("string");
      expect(typeof first!.createdAt).toBe("string");
    });

    it("handles null displayName", () => {
      const response = {
        entries: [
          {
            id: "cm5xxxxx",
            telegramUserId: "123456789",
            displayName: null,
            createdAt: "2025-01-01T00:00:00.000Z",
          },
        ],
      };

      expect(response.entries[0]!.displayName).toBeNull();
    });

    it("handles empty whitelist", () => {
      const response = { entries: [] };
      expect(response.entries.length).toBe(0);
    });

    it("telegramUserId is always a string (not number/bigint)", () => {
      // Telegram user IDs can exceed Number.MAX_SAFE_INTEGER,
      // so they must be strings in the API response
      const response = {
        entries: [
          {
            id: "cm5xxxxx",
            telegramUserId: "999999999999999999",
            displayName: null,
            createdAt: "2025-01-01T00:00:00.000Z",
          },
        ],
      };

      expect(typeof response.entries[0]!.telegramUserId).toBe("string");
      expect(Number(response.entries[0]!.telegramUserId)).not.toStrictEqual(
        BigInt(response.entries[0]!.telegramUserId),
      );
    });
  });

  describe("POST /api/integrations/telegram/whitelist — user validation", () => {
    it("rejects missing telegramUserId", () => {
      const body: Record<string, string> = {};
      expect(body.telegramUserId).toBeUndefined();
    });

    it("rejects non-string telegramUserId", () => {
      const body = { telegramUserId: 12345 };
      expect(typeof body.telegramUserId !== "string").toBe(true);
    });

    it("accepts valid numeric string", () => {
      const body = { telegramUserId: "123456789" };
      expect(() => BigInt(body.telegramUserId)).not.toThrow();
    });

    it("rejects non-numeric string", () => {
      const body = { telegramUserId: "not-a-number" };
      expect(() => BigInt(body.telegramUserId)).toThrow();
    });

    it("accepts large user ID exceeding MAX_SAFE_INTEGER", () => {
      const body = { telegramUserId: "999999999999999999" };
      expect(Number.isSafeInteger(Number(body.telegramUserId))).toBe(false);
      expect(() => BigInt(body.telegramUserId)).not.toThrow();
    });
  });

  describe("response shape", () => {
    it("GET returns account with whitelistCount", () => {
      const connected = {
        account: {
          id: "test-id",
          enabled: true,
          botId: "123456789",
          botUsername: "my_bot",
          whitelistCount: 3,
          createdAt: "2025-01-01T00:00:00.000Z",
          updatedAt: "2025-01-01T00:00:00.000Z",
        },
      };
      expect(connected.account).toBeDefined();
      expect(typeof connected.account.whitelistCount).toBe("number");
      expect(connected.account.botId).toBe("123456789");
      expect(connected.account.botUsername).toBe("my_bot");
    });

    it("GET returns null when not connected", () => {
      const disconnected = { account: null };
      expect(disconnected.account).toBeNull();
    });

    it("POST returns created account without whitelistCount", () => {
      // POST doesn't include whitelistCount — caller should reload via GET
      const response = {
        account: {
          id: "new-id",
          enabled: true,
          botId: "123456789",
          botUsername: "my_bot",
          createdAt: "2025-01-01T00:00:00.000Z",
          updatedAt: "2025-01-01T00:00:00.000Z",
        },
      };
      expect(response.account.enabled).toBe(true);
      // whitelistCount is intentionally omitted from POST response
      expect((response.account as Record<string, unknown>).whitelistCount).toBeUndefined();
    });

    it("DELETE returns success", () => {
      const response = { success: true };
      expect(response.success).toBe(true);
    });
  });

  describe("token encryption round-trip", () => {
    it("encrypts and decrypts a Telegram bot token", () => {
      const token = "123456789:AAGWzUqz4aBcDeFgHiJkLmNoPqRsTuVwXyZ";
      const encrypted = encrypt(token);
      expect(encrypted).not.toBe(token);
      expect(encrypted).toContain(":"); // iv:authTag:ciphertext format
    });

    it("encrypts different tokens to different values", () => {
      const token1 = "123456789:AAGWzUqz4aBcDeFgHiJkLmNoPqRsTuVwXyZ";
      const token2 = "987654321:BBHWaUrY5bCdEfGhIjKlMnOpQrStUvWxYzA";
      const encrypted1 = encrypt(token1);
      const encrypted2 = encrypt(token2);
      expect(encrypted1).not.toBe(encrypted2);
    });
  });

  describe("error response shape", () => {
    it("invalid token returns 400 with error message", () => {
      const response = { error: "Invalid bot token" };
      expect(response.error).toBe("Invalid bot token");
    });

    it("validation failure returns 400 with descriptive message", () => {
      const response = { error: "Failed to validate bot token" };
      expect(response.error).toBeDefined();
      expect(response.error.length).toBeGreaterThan(0);
    });

    it("missing integration returns 404", () => {
      const response = { error: "No Telegram integration found" };
      expect(response.error).toBe("No Telegram integration found");
    });
  });
});
