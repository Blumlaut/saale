import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks ───────────────────────────────────────────────────────────────────

const {
  mockGetTelegramBot,
  mockGetLinkByUserId,
  mockSendTelegramMessage,
  mockRecordOutboundMessage,
  mockRecordOutboundMessages,
} = vi.hoisted(() => ({
  mockGetTelegramBot: vi.fn(),
  mockGetLinkByUserId: vi.fn(),
  mockSendTelegramMessage: vi.fn(),
  mockRecordOutboundMessage: vi.fn(),
  mockRecordOutboundMessages: vi.fn(),
}));

vi.mock("@/lib/telegram/bot", () => ({
  getTelegramBot: (...args: unknown[]) => mockGetTelegramBot(...args),
}));

vi.mock("@/lib/telegram/links", () => ({
  getLinkByUserId: (...args: unknown[]) => mockGetLinkByUserId(...args),
}));

vi.mock("@/lib/telegram/client", () => ({
  sendTelegramMessage: (...args: unknown[]) => mockSendTelegramMessage(...args),
}));

vi.mock("@/lib/telegram/outbound", () => ({
  recordOutboundMessage: (...args: unknown[]) => mockRecordOutboundMessage(...args),
}));

vi.mock("@/lib/telegram/outbound-messages", () => ({
  recordOutboundMessages: (...args: unknown[]) => mockRecordOutboundMessages(...args),
}));

const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

import { deliverTelegramMessage, sendTelegramToUser } from "@/lib/telegram/notify";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const userId = "user-1";
const chatId = BigInt("119075844");

/** The configured bot, as `getTelegramBot` returns it. */
const bot = {
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

/** The user's link, as `getLinkByUserId` returns it. */
const link = {
  id: "link-1",
  userId,
  telegramUserId: chatId,
  telegramChatId: chatId,
  displayName: "Jane",
  sessionId: "sess-1",
  createdAt: new Date("2026-02-01T00:00:00.000Z"),
  updatedAt: new Date("2026-02-01T00:00:00.000Z"),
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetTelegramBot.mockResolvedValue(bot);
  mockGetLinkByUserId.mockResolvedValue(link);
  mockSendTelegramMessage.mockResolvedValue([42]);
  mockRecordOutboundMessage.mockResolvedValue(undefined);
  mockRecordOutboundMessages.mockResolvedValue(undefined);
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("sendTelegramToUser", () => {
  it("fails with a fixable reason when the instance has no bot", async () => {
    mockGetTelegramBot.mockResolvedValue(null);

    const result = await sendTelegramToUser({ userId, content: "hello" });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("bot_not_configured");
    // The message must name the fix  the agent repeats it to the user.
    expect(result.error).toContain("admin");
    expect(mockSendTelegramMessage).not.toHaveBeenCalled();
  });

  it("fails when the bot is configured but switched off", async () => {
    mockGetTelegramBot.mockResolvedValue({ ...bot, enabled: false });

    const result = await sendTelegramToUser({ userId, content: "hello" });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("bot_disabled");
    expect(mockGetLinkByUserId).not.toHaveBeenCalled();
    expect(mockSendTelegramMessage).not.toHaveBeenCalled();
  });

  it("fails when the user has not linked an account", async () => {
    mockGetLinkByUserId.mockResolvedValue(null);

    const result = await sendTelegramToUser({ userId, content: "hello" });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("not_linked");
    expect(result.error).toContain("Integrations");
    expect(mockSendTelegramMessage).not.toHaveBeenCalled();
  });

  it("sends to the caller's own linked chat, labelled with their name", async () => {
    const result = await sendTelegramToUser({ userId, content: "Dentist in 30 minutes" });

    expect(result).toEqual({ ok: true, chatId: "119075844", label: "Jane" });
    expect(mockGetLinkByUserId).toHaveBeenCalledWith(userId);
    expect(mockSendTelegramMessage).toHaveBeenCalledWith("enc", chatId, "Dentist in 30 minutes");
    // Recorded so a reply to the reminder continues the thread, and ledgered so
    // the reply itself can be routed back.
    expect(mockRecordOutboundMessage).toHaveBeenCalledWith({
      userId,
      content: "Dentist in 30 minutes",
      sourceSessionId: undefined,
    });
    expect(mockRecordOutboundMessages).toHaveBeenCalledWith({
      userId,
      chatId,
      messageIds: [42],
      sourceSessionId: undefined,
    });
  });

  it("omits the label when the link has no cached name", async () => {
    mockGetLinkByUserId.mockResolvedValue({ ...link, displayName: null });

    const result = await sendTelegramToUser({ userId, content: "hi" });

    expect(result).toEqual({ ok: true, chatId: "119075844" });
  });

  it("never targets anyone but the caller", async () => {
    // The recipient is resolved from the user id alone  there is no parameter
    // through which a different chat could be named.
    await sendTelegramToUser({ userId, content: "hi" });

    expect(mockGetLinkByUserId).toHaveBeenCalledTimes(1);
    expect(mockSendTelegramMessage).toHaveBeenCalledTimes(1);
    expect(mockSendTelegramMessage.mock.calls[0]![1]).toBe(chatId);
  });

  it("surfaces a rejected send with the provider's reason", async () => {
    mockSendTelegramMessage.mockRejectedValue(new Error("Forbidden: bot was blocked by the user"));

    const result = await sendTelegramToUser({ userId, content: "hello" });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("send_failed");
    expect(result.error).toContain("blocked by the user");
  });

  it("delivers even when recording the message for replies fails", async () => {
    mockRecordOutboundMessage.mockRejectedValue(new Error("db down"));

    const result = await sendTelegramToUser({ userId, content: "hello" });

    // Bookkeeping must never hold back the message.
    expect(result.ok).toBe(true);
    expect(mockSendTelegramMessage).toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to record outbound message"),
      expect.any(Error),
    );
  });
});

describe("deliverTelegramMessage", () => {
  it("sends and records the message for reply context", async () => {
    const result = await deliverTelegramMessage({
      userId,
      encryptedToken: "enc",
      chatId,
      content: "hello",
    });

    expect(result).toEqual({ ok: true, chatId: "119075844" });
    expect(mockSendTelegramMessage).toHaveBeenCalledWith("enc", chatId, "hello");
    expect(mockRecordOutboundMessage).toHaveBeenCalledWith({
      userId,
      content: "hello",
      sourceSessionId: undefined,
    });
  });

  it("carries the source chat into both records", async () => {
    await deliverTelegramMessage({
      userId,
      encryptedToken: "enc",
      chatId,
      content: "CVE-2026-1 affects lodash",
      sourceSessionId: "sess-9",
    });

    expect(mockRecordOutboundMessage).toHaveBeenCalledWith({
      userId,
      content: "CVE-2026-1 affects lodash",
      sourceSessionId: "sess-9",
    });
    expect(mockRecordOutboundMessages).toHaveBeenCalledWith({
      userId,
      chatId,
      messageIds: [42],
      sourceSessionId: "sess-9",
    });
  });

  it("delivers even when the ledger write fails", async () => {
    mockRecordOutboundMessages.mockRejectedValue(new Error("db down"));

    const result = await deliverTelegramMessage({
      userId,
      encryptedToken: "enc",
      chatId,
      content: "hello",
    });

    expect(result.ok).toBe(true);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to ledger outbound messages"),
      expect.any(Error),
    );
  });

  it("returns a failed result rather than throwing", async () => {
    mockSendTelegramMessage.mockRejectedValue(new Error("Bad Request: chat not found"));

    const result = await deliverTelegramMessage({
      userId,
      encryptedToken: "enc",
      chatId,
      content: "hello",
    });

    expect(result).toEqual({
      ok: false,
      chatId: "119075844",
      reason: "send_failed",
      error: "Bad Request: chat not found",
    });
  });
});
