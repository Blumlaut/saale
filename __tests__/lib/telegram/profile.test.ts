import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Mocks ───────────────────────────────────────────────────────────────────

const { mockValidateBotToken } = vi.hoisted(() => ({ mockValidateBotToken: vi.fn() }));

vi.mock("@/lib/telegram/client", () => ({
  validateBotToken: (...args: unknown[]) => mockValidateBotToken(...args),
}));

vi.mock("@/lib/crypto", () => ({ decrypt: (value: string) => `plain(${value})` }));

const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

import type { TelegramBotConfig } from "@/lib/telegram/bot";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const SAVED_AT = new Date("2025-01-01T00:00:00Z");

function bot(overrides: Partial<TelegramBotConfig> = {}): TelegramBotConfig {
  return {
    id: "global",
    encryptedToken: "enc-token",
    enabled: true,
    botId: BigInt(123456789),
    botUsername: "saale_bot",
    webhookSecret: "secret",
    updatedByUserId: "admin-1",
    createdAt: SAVED_AT,
    updatedAt: SAVED_AT,
    ...overrides,
  };
}

/** A fresh module per test, so the read cache starts empty. */
async function loadProfileModule() {
  vi.resetModules();
  const { readTelegramBotProfile } = await import("@/lib/telegram/profile");
  return readTelegramBotProfile;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2025-01-02T00:00:00Z"));
  mockValidateBotToken.mockResolvedValue({
    botId: 123456789,
    botUsername: "saale_bot",
    botFirstName: "Saale",
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("readTelegramBotProfile", () => {
  it("reads the bot's name, handle and picture from Telegram", async () => {
    const readTelegramBotProfile = await loadProfileModule();

    expect(await readTelegramBotProfile(bot())).toEqual({
      firstName: "Saale",
      username: "saale_bot",
      avatarUrl: "https://t.me/i/userpic/320/saale_bot.jpg",
    });
    expect(mockValidateBotToken).toHaveBeenCalledWith("plain(enc-token)");
  });

  it("has no picture for a bot without a username", async () => {
    mockValidateBotToken.mockResolvedValue({
      botId: 123456789,
      botUsername: null,
      botFirstName: "Saale",
    });
    const readTelegramBotProfile = await loadProfileModule();

    expect((await readTelegramBotProfile(bot()))?.avatarUrl).toBeNull();
  });

  it("reuses a read for five minutes", async () => {
    const readTelegramBotProfile = await loadProfileModule();

    await readTelegramBotProfile(bot());
    vi.advanceTimersByTime(4 * 60_000);
    await readTelegramBotProfile(bot());
    expect(mockValidateBotToken).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2 * 60_000);
    await readTelegramBotProfile(bot());
    expect(mockValidateBotToken).toHaveBeenCalledTimes(2);
  });

  it("reads again for a bot that was saved since the last read", async () => {
    const readTelegramBotProfile = await loadProfileModule();

    await readTelegramBotProfile(bot());
    mockValidateBotToken.mockResolvedValue({
      botId: 987654321,
      botUsername: "other_bot",
      botFirstName: "Other",
    });
    const profile = await readTelegramBotProfile(
      bot({ updatedAt: new Date("2025-01-02T00:00:30Z") }),
    );

    expect(profile?.username).toBe("other_bot");
    expect(mockValidateBotToken).toHaveBeenCalledTimes(2);
  });

  it("reports nothing and waits a minute when Telegram rejects the token", async () => {
    mockValidateBotToken.mockRejectedValue(new Error("Unauthorized"));
    const readTelegramBotProfile = await loadProfileModule();

    expect(await readTelegramBotProfile(bot())).toBeNull();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "Failed to read the Telegram bot profile:",
      expect.any(Error),
    );

    vi.advanceTimersByTime(30_000);
    expect(await readTelegramBotProfile(bot())).toBeNull();
    expect(mockValidateBotToken).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(31_000);
    await readTelegramBotProfile(bot());
    expect(mockValidateBotToken).toHaveBeenCalledTimes(2);
  });
});
