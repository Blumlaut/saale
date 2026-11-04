import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GrammyError } from "grammy";

// ─── Mocks ───────────────────────────────────────────────────────────────────

const {
  mockGetEnabledTelegramBot,
  mockCreateBot,
  mockGetWebhookInfo,
  mockGetUpdates,
  mockHandleTelegramUpdate,
} = vi.hoisted(() => ({
  mockGetEnabledTelegramBot: vi.fn(),
  mockCreateBot: vi.fn(),
  mockGetWebhookInfo: vi.fn(),
  mockGetUpdates: vi.fn(),
  mockHandleTelegramUpdate: vi.fn(),
}));

vi.mock("@/lib/telegram/bot", () => ({
  getEnabledTelegramBot: (...args: unknown[]) => mockGetEnabledTelegramBot(...args),
}));

vi.mock("@/lib/telegram/client", () => ({
  createBot: (...args: unknown[]) => mockCreateBot(...args),
}));

// Handling an update is the webhook test's territory. Here the poll only has to
// hand the update over.
vi.mock("@/lib/telegram/updates", () => ({
  handleTelegramUpdate: (...args: unknown[]) => mockHandleTelegramUpdate(...args),
}));

const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});

import { reconcileTelegramDelivery, startTelegramDeliveryWatcher } from "@/lib/telegram/polling";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const botConfig = {
  id: "global",
  encryptedToken: "enc",
  enabled: true,
  botId: BigInt(1),
  botUsername: "saale_bot",
  webhookSecret: "secret",
  updatedByUserId: "admin-1",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};

const update = {
  update_id: 41,
  message: {
    message_id: 7,
    chat: { id: 7256145893, type: "private" },
    from: { id: 7256145893, first_name: "Jane" },
    text: "hello",
  },
};

/** A long poll Telegram never answers, the way a real idle poll behaves. */
const idlePoll = () => new Promise<never>(() => {});

function stopWatching(): Promise<void> {
  mockGetEnabledTelegramBot.mockResolvedValue(null);
  return reconcileTelegramDelivery();
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("reconcileTelegramDelivery", () => {
  beforeEach(() => {
    mockCreateBot.mockReturnValue({
      api: { getWebhookInfo: mockGetWebhookInfo, getUpdates: mockGetUpdates },
    });
    mockGetUpdates.mockImplementation(idlePoll);
    mockHandleTelegramUpdate.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await stopWatching();
    vi.clearAllMocks();
  });

  it("leaves delivery alone when the bot is off", async () => {
    mockGetEnabledTelegramBot.mockResolvedValue(null);

    await reconcileTelegramDelivery();

    expect(mockGetWebhookInfo).not.toHaveBeenCalled();
    expect(mockGetUpdates).not.toHaveBeenCalled();
  });

  it("does not poll while a webhook is set", async () => {
    mockGetEnabledTelegramBot.mockResolvedValue(botConfig);
    mockGetWebhookInfo.mockResolvedValue({
      url: "https://saale.example/api/integrations/telegram/webhook",
    });

    await reconcileTelegramDelivery();

    expect(mockGetUpdates).not.toHaveBeenCalled();
  });

  it("keeps delivery as it is when Telegram cannot be reached", async () => {
    mockGetEnabledTelegramBot.mockResolvedValue(botConfig);
    mockGetWebhookInfo.mockRejectedValue(new Error("getaddrinfo ENOTFOUND api.telegram.org"));

    await reconcileTelegramDelivery();

    expect(mockGetUpdates).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it("polls a bot Telegram has no webhook for and hands over each update", async () => {
    mockGetEnabledTelegramBot.mockResolvedValue(botConfig);
    mockGetWebhookInfo.mockResolvedValue({ url: "" });
    mockGetUpdates.mockResolvedValueOnce([update]);

    await reconcileTelegramDelivery();

    await vi.waitFor(() =>
      expect(mockHandleTelegramUpdate).toHaveBeenCalledWith(update, botConfig),
    );
    // The next poll confirms the update that was just handled.
    await vi.waitFor(() => expect(mockGetUpdates).toHaveBeenCalledTimes(2));
    expect(mockGetUpdates.mock.calls[1]?.[0]).toMatchObject({ offset: update.update_id + 1 });
  });

  it("keeps polling until the bot is switched off", async () => {
    mockGetEnabledTelegramBot.mockResolvedValue(botConfig);
    mockGetWebhookInfo.mockResolvedValue({ url: "" });

    await reconcileTelegramDelivery();
    expect(mockGetUpdates).toHaveBeenCalledTimes(1);

    // A second reconcile with the same token leaves the running loop alone.
    await reconcileTelegramDelivery();
    expect(mockGetWebhookInfo).toHaveBeenCalledTimes(1);
    expect(mockGetUpdates).toHaveBeenCalledTimes(1);

    await stopWatching();
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("Stopped polling"));
  });

  it("starts a new poll when the saved token changes", async () => {
    mockGetEnabledTelegramBot.mockResolvedValue(botConfig);
    mockGetWebhookInfo.mockResolvedValue({ url: "" });

    await reconcileTelegramDelivery();
    expect(mockCreateBot).toHaveBeenCalledWith("enc");

    mockGetEnabledTelegramBot.mockResolvedValue({ ...botConfig, encryptedToken: "enc2" });
    await reconcileTelegramDelivery();

    expect(mockCreateBot).toHaveBeenCalledWith("enc2");
  });

  it("gives the poll back when a webhook appears", async () => {
    mockGetEnabledTelegramBot.mockResolvedValue(botConfig);
    mockGetWebhookInfo.mockResolvedValueOnce({ url: "" });

    await reconcileTelegramDelivery();
    expect(mockGetUpdates).toHaveBeenCalledTimes(1);

    // A saved token re-checks the bot, and this time Telegram holds a webhook.
    mockGetEnabledTelegramBot.mockResolvedValue({ ...botConfig, encryptedToken: "enc2" });
    mockGetWebhookInfo.mockResolvedValueOnce({
      url: "https://saale.example/api/integrations/telegram/webhook",
    });
    await reconcileTelegramDelivery();

    expect(mockGetUpdates).toHaveBeenCalledTimes(1);
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("Stopped polling"));
  });

  it("stops polling when Telegram refuses it because a webhook is active", async () => {
    mockGetEnabledTelegramBot.mockResolvedValue(botConfig);
    mockGetWebhookInfo.mockResolvedValue({ url: "" });
    mockGetUpdates.mockRejectedValue(
      new GrammyError(
        "Call to 'getUpdates' failed!",
        {
          ok: false,
          error_code: 409,
          description: "Conflict: can't use getUpdates method while webhook is active",
        },
        "getUpdates",
        {},
      ),
    );

    await reconcileTelegramDelivery();

    await vi.waitFor(() =>
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("Stopped polling")),
    );
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });
});

describe("startTelegramDeliveryWatcher", () => {
  afterEach(async () => {
    await stopWatching();
    vi.clearAllMocks();
  });

  it("checks delivery on start and stops with its stop function", async () => {
    vi.useFakeTimers();
    try {
      mockGetEnabledTelegramBot.mockResolvedValue(botConfig);
      mockCreateBot.mockReturnValue({
        api: { getWebhookInfo: mockGetWebhookInfo, getUpdates: mockGetUpdates },
      });
      mockGetWebhookInfo.mockResolvedValue({ url: "https://saale.example/hook" });

      const stop = startTelegramDeliveryWatcher();
      await vi.waitFor(() => expect(mockGetWebhookInfo).toHaveBeenCalledTimes(1));

      await vi.advanceTimersByTimeAsync(60_000);
      expect(mockGetWebhookInfo).toHaveBeenCalledTimes(2);

      stop();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(mockGetWebhookInfo).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
