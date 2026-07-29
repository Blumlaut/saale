// Set env before importing crypto module
process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { _resetKey } from "@/lib/crypto";
import { encrypt, decrypt } from "@/lib/crypto";
import { buildWebhookUrl } from "@/lib/telegram";

describe("Telegram integration — client", () => {
  beforeEach(() => {
    _resetKey();
  });

  describe("buildWebhookUrl", () => {
    const originalEnv = { ...process.env };

    it.each([
      {
        var: "NGROK_URL",
        value: "https://abc123.ngrok.io",
        expected: "https://abc123.ngrok.io/api/integrations/telegram/webhook/test-id",
      },
      {
        var: "VERCEL_URL",
        value: "myapp.vercel.app",
        expected: "https://myapp.vercel.app/api/integrations/telegram/webhook/test-id",
      },
      {
        var: "NEXT_PUBLIC_BASE_URL",
        value: "https://saale.example.com",
        expected: "https://saale.example.com/api/integrations/telegram/webhook/test-id",
      },
      {
        var: "APP_URL",
        value: "http://localhost:3000",
        expected: "http://localhost:3000/api/integrations/telegram/webhook/test-id",
      },
    ])(`uses $var when set`, ({ var: envVar, value, expected }) => {
      // Clear all priority env vars, set only the one being tested
      delete process.env.NGROK_URL;
      delete process.env.VERCEL_URL;
      delete process.env.NEXT_PUBLIC_BASE_URL;
      delete process.env.APP_URL;
      process.env[envVar] = value;

      expect(buildWebhookUrl("test-id")).toBe(expected);
    });

    it("prefers NGROK_URL over VERCEL_URL", () => {
      delete process.env.NEXT_PUBLIC_BASE_URL;
      delete process.env.APP_URL;
      process.env.NGROK_URL = "https://ngrok.test";
      process.env.VERCEL_URL = "vercel.test";

      expect(buildWebhookUrl("id")).toBe("https://ngrok.test/api/integrations/telegram/webhook/id");
    });

    it("prefers VERCEL_URL over NEXT_PUBLIC_BASE_URL", () => {
      delete process.env.NGROK_URL;
      delete process.env.APP_URL;
      process.env.VERCEL_URL = "vercel.test";
      process.env.NEXT_PUBLIC_BASE_URL = "https://public.test";

      expect(buildWebhookUrl("id")).toBe(
        "https://vercel.test/api/integrations/telegram/webhook/id",
      );
    });

    it("falls back to localhost when no env set", () => {
      delete process.env.NGROK_URL;
      delete process.env.VERCEL_URL;
      delete process.env.NEXT_PUBLIC_BASE_URL;
      delete process.env.APP_URL;

      expect(buildWebhookUrl("id")).toBe(
        "http://localhost:3630/api/integrations/telegram/webhook/id",
      );
    });

    afterAll(() => {
      Object.assign(process.env, originalEnv);
    });
  });

  describe("token encryption", () => {
    it("encrypts and decrypts a Telegram bot token", () => {
      const token = "123456789:AAGWzUqz4aBcDeFgHiJkLmNoPqRsTuVwXyZ";
      const encrypted = encrypt(token);
      expect(encrypted).not.toBe(token);
      expect(decrypt(encrypted)).toBe(token);
    });

    it("encrypts different tokens to different values", () => {
      const token1 = "123456789:AAGWzUqz4aBcDeFgHiJkLmNoPqRsTuVwXyZ";
      const token2 = "987654321:BBHWaUrY5bCdEfGhIjKlMnOpQrStUvWxYzA";
      expect(encrypt(token1)).not.toBe(encrypt(token2));
    });

    it("handles tokens with special characters", () => {
      const token = "123:AAG_Wz.Uq+z4a=Bc~De`Fg|Hi\\Jk";
      const encrypted = encrypt(token);
      expect(decrypt(encrypted)).toBe(token);
    });
  });
});
