import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks ───────────────────────────────────────────────────────────────────

const {
  mockTelegramBot,
  mockTelegramLink,
  mockValidateBotToken,
  mockRegisterWebhook,
  mockDeleteWebhook,
  mockEncrypt,
} = vi.hoisted(() => ({
  mockTelegramBot: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  mockTelegramLink: { count: vi.fn() },
  mockValidateBotToken: vi.fn(),
  mockRegisterWebhook: vi.fn(),
  mockDeleteWebhook: vi.fn(),
  mockEncrypt: vi.fn((text: string) => `enc(${text})`),
}));

vi.mock("@/lib/db", () => ({
  prisma: { telegramBot: mockTelegramBot, telegramLink: mockTelegramLink },
}));

vi.mock("@/lib/crypto", () => ({ encrypt: (text: string) => mockEncrypt(text) }));

vi.mock("@/lib/telegram/client", () => ({
  validateBotToken: (...args: unknown[]) => mockValidateBotToken(...args),
  registerWebhook: (...args: unknown[]) => mockRegisterWebhook(...args),
  deleteWebhook: (...args: unknown[]) => mockDeleteWebhook(...args),
}));

const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

import {
  TELEGRAM_BOT_ID,
  getEnabledTelegramBot,
  getTelegramBot,
  registerTelegramWebhook,
  removeTelegramBot,
  saveTelegramBot,
  setTelegramBotEnabled,
} from "@/lib/telegram/bot";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const token = "123456789:AAGWzUqz4aBcDeFgHiJkLmNoPqRsTuVwXyZ";

/** A stored bot row as Prisma would return it. */
function botRow(overrides: Record<string, unknown> = {}) {
  return {
    id: TELEGRAM_BOT_ID,
    encryptedToken: `enc(${token})`,
    enabled: true,
    botId: BigInt(123456789),
    botUsername: "saale_bot",
    webhookSecret: "secret",
    updatedByUserId: "admin-1",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockValidateBotToken.mockResolvedValue({
    botId: BigInt(123456789),
    botUsername: "saale_bot",
    botFirstName: "Saale",
  });
  mockRegisterWebhook.mockResolvedValue(true);
  mockDeleteWebhook.mockResolvedValue(true);
  mockTelegramBot.upsert.mockImplementation(async ({ create }: { create: unknown }) =>
    botRow(create as Record<string, unknown>),
  );
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("getTelegramBot / getEnabledTelegramBot", () => {
  it("reports no bot when none is configured", async () => {
    mockTelegramBot.findUnique.mockResolvedValue(null);

    expect(await getTelegramBot()).toBeNull();
    expect(await getEnabledTelegramBot()).toBeNull();
    expect(mockTelegramBot.findUnique).toHaveBeenCalledWith({ where: { id: TELEGRAM_BOT_ID } });
  });

  it("withholds a bot that is switched off from enabled lookups", async () => {
    mockTelegramBot.findUnique.mockResolvedValue(botRow({ enabled: false }));

    expect((await getTelegramBot())?.enabled).toBe(false);
    expect(await getEnabledTelegramBot()).toBeNull();
  });

  it("returns the bot when it is switched on", async () => {
    mockTelegramBot.findUnique.mockResolvedValue(botRow());

    expect((await getEnabledTelegramBot())?.botUsername).toBe("saale_bot");
  });
});

describe("saveTelegramBot", () => {
  it("validates the token, encrypts it, and publishes the webhook", async () => {
    const result = await saveTelegramBot({ token, adminUserId: "admin-1" });

    expect(mockValidateBotToken).toHaveBeenCalledWith(token);

    const upsertArgs = mockTelegramBot.upsert.mock.calls[0]![0];
    expect(upsertArgs.where).toEqual({ id: TELEGRAM_BOT_ID });
    // The plaintext token must never reach the database.
    expect(upsertArgs.create.encryptedToken).toBe(`enc(${token})`);
    expect(upsertArgs.create.encryptedToken).not.toBe(token);
    expect(upsertArgs.create.botUsername).toBe("saale_bot");
    expect(upsertArgs.create.updatedByUserId).toBe("admin-1");
    expect(upsertArgs.create.webhookSecret).toMatch(/^[0-9a-f]{64}$/);

    // The webhook is registered with the secret that was just stored, so the
    // header Telegram signs with is the one verification will accept.
    expect(mockRegisterWebhook).toHaveBeenCalledWith(
      `enc(${token})`,
      upsertArgs.create.webhookSecret,
    );
    expect(result.webhookRegistered).toBe(true);
  });

  it("rotates the webhook secret on every save", async () => {
    const first = await saveTelegramBot({ token, adminUserId: "admin-1" });
    const second = await saveTelegramBot({ token, adminUserId: "admin-1" });

    expect(first.bot.webhookSecret).not.toBe(second.bot.webhookSecret);
  });

  it("keeps the config and flags the failure when Telegram rejects the webhook", async () => {
    mockRegisterWebhook.mockRejectedValue(new Error("Bad Request: invalid webhook URL"));

    const result = await saveTelegramBot({ token, adminUserId: "admin-1" });

    // Stored anyway  the worker retries registration on its next startup with
    // the secret that is now in the database.
    expect(result.webhookRegistered).toBe(false);
    expect(mockTelegramBot.upsert).toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "Failed to register the shared Telegram webhook:",
      expect.any(Error),
    );
  });

  it("rejects an invalid token without storing anything", async () => {
    mockValidateBotToken.mockRejectedValue(new Error("Unauthorized"));

    await expect(saveTelegramBot({ token: "nonsense", adminUserId: "admin-1" })).rejects.toThrow(
      "Unauthorized",
    );
    expect(mockTelegramBot.upsert).not.toHaveBeenCalled();
    expect(mockRegisterWebhook).not.toHaveBeenCalled();
  });
});

describe("setTelegramBotEnabled", () => {
  it("deletes the webhook when switched off and keeps the links", async () => {
    mockTelegramBot.update.mockResolvedValue(botRow({ enabled: false }));

    const bot = await setTelegramBotEnabled(false);

    expect(bot.enabled).toBe(false);
    expect(mockDeleteWebhook).toHaveBeenCalledWith(`enc(${token})`);
    expect(mockRegisterWebhook).not.toHaveBeenCalled();
    // Pausing must not unlink anyone  nothing may delete a link here.
    expect(mockTelegramLink.count).not.toHaveBeenCalled();
  });

  it("registers the webhook when switched back on", async () => {
    mockTelegramBot.update.mockResolvedValue(botRow({ enabled: true }));

    await setTelegramBotEnabled(true);

    expect(mockRegisterWebhook).toHaveBeenCalledWith(`enc(${token})`, "secret");
    expect(mockDeleteWebhook).not.toHaveBeenCalled();
  });

  it("keeps the stored state when Telegram cannot be told", async () => {
    mockTelegramBot.update.mockResolvedValue(botRow({ enabled: false }));
    mockDeleteWebhook.mockRejectedValue(new Error("network down"));

    const bot = await setTelegramBotEnabled(false);

    expect(bot.enabled).toBe(false);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "Failed to delete the shared Telegram webhook:",
      expect.any(Error),
    );
  });
});

describe("removeTelegramBot", () => {
  it("deletes the webhook and then the bot, cascading its links", async () => {
    mockTelegramBot.findUnique.mockResolvedValue(botRow());
    mockTelegramBot.delete.mockResolvedValue(botRow());

    expect(await removeTelegramBot()).toBe(true);
    expect(mockDeleteWebhook).toHaveBeenCalledWith(`enc(${token})`);
    expect(mockTelegramBot.delete).toHaveBeenCalledWith({ where: { id: TELEGRAM_BOT_ID } });
  });

  it("reports nothing to remove when no bot is configured", async () => {
    mockTelegramBot.findUnique.mockResolvedValue(null);

    expect(await removeTelegramBot()).toBe(false);
    expect(mockTelegramBot.delete).not.toHaveBeenCalled();
  });

  it("still removes the bot when Telegram cannot be reached", async () => {
    mockTelegramBot.findUnique.mockResolvedValue(botRow());
    mockTelegramBot.delete.mockResolvedValue(botRow());
    mockDeleteWebhook.mockRejectedValue(new Error("network down"));

    expect(await removeTelegramBot()).toBe(true);
    expect(mockTelegramBot.delete).toHaveBeenCalled();
  });
});

describe("registerTelegramWebhook", () => {
  it("does nothing when no bot is configured", async () => {
    mockTelegramBot.findUnique.mockResolvedValue(null);

    await registerTelegramWebhook();

    expect(mockRegisterWebhook).not.toHaveBeenCalled();
  });

  it("does nothing when the bot is switched off", async () => {
    mockTelegramBot.findUnique.mockResolvedValue(botRow({ enabled: false }));

    await registerTelegramWebhook();

    expect(mockRegisterWebhook).not.toHaveBeenCalled();
  });

  it("re-publishes the stored webhook on startup", async () => {
    mockTelegramBot.findUnique.mockResolvedValue(botRow());

    await registerTelegramWebhook();

    expect(mockRegisterWebhook).toHaveBeenCalledWith(`enc(${token})`, "secret");
  });
});
