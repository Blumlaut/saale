import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks ───────────────────────────────────────────────────────────────────

const { mockTelegramAccount, mockSendTelegramMessage } = vi.hoisted(() => ({
  mockTelegramAccount: { findUnique: vi.fn() },
  mockSendTelegramMessage: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: { telegramAccount: mockTelegramAccount },
}));

vi.mock("@/lib/telegram/client", () => ({
  sendTelegramMessage: (...args: unknown[]) => mockSendTelegramMessage(...args),
}));

const mockResolveNotifyChat = vi.fn();
vi.mock("@/lib/telegram/chats", () => ({
  resolveNotifyChat: (...args: unknown[]) => mockResolveNotifyChat(...args),
}));

const mockRecordTelegramJobOutput = vi.fn();
vi.mock("@/lib/telegram/outbound", () => ({
  recordTelegramJobOutput: (...args: unknown[]) => mockRecordTelegramJobOutput(...args),
}));

const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

import { deliverTelegramMessage, sendTelegramToUser } from "@/lib/telegram/notify";

// ─── Tests ───────────────────────────────────────────────────────────────────

const userId = "user-1";
const chatId = BigInt("119075844");

describe("sendTelegramToUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRecordTelegramJobOutput.mockResolvedValue(undefined);
    mockSendTelegramMessage.mockResolvedValue([42]);
  });

  it("fails with a fixable reason when no bot is connected", async () => {
    mockTelegramAccount.findUnique.mockResolvedValue(null);

    const result = await sendTelegramToUser({ userId, content: "hello" });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("not_configured");
    // The message must name the fix — the agent repeats it to the user.
    expect(result.error).toContain("Settings");
    expect(mockSendTelegramMessage).not.toHaveBeenCalled();
  });

  it("fails when the integration is connected but switched off", async () => {
    mockTelegramAccount.findUnique.mockResolvedValue({
      id: "acc-1",
      encryptedToken: "enc",
      enabled: false,
      notifyChatId: null,
    });

    const result = await sendTelegramToUser({ userId, content: "hello" });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("disabled");
    expect(mockResolveNotifyChat).not.toHaveBeenCalled();
  });

  it("fails when nothing is reachable, without trying to send", async () => {
    mockTelegramAccount.findUnique.mockResolvedValue({
      id: "acc-1",
      encryptedToken: "enc",
      enabled: true,
      notifyChatId: null,
    });
    mockResolveNotifyChat.mockResolvedValue(null);

    const result = await sendTelegramToUser({ userId, content: "hello" });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("no_chat");
    expect(mockSendTelegramMessage).not.toHaveBeenCalled();
  });

  it("resolves against the account's pinned chat", async () => {
    mockTelegramAccount.findUnique.mockResolvedValue({
      id: "acc-1",
      encryptedToken: "enc",
      enabled: true,
      notifyChatId: chatId,
    });
    mockResolveNotifyChat.mockResolvedValue({
      chatId,
      label: "Jane",
      source: "pinned",
    });

    const result = await sendTelegramToUser({ userId, content: "Dentist in 30 minutes" });

    expect(result).toEqual({ ok: true, chatId: "119075844", label: "Jane" });
    expect(mockResolveNotifyChat).toHaveBeenCalledWith("acc-1", chatId);
    expect(mockSendTelegramMessage).toHaveBeenCalledWith("enc", chatId, "Dentist in 30 minutes");
    // Recorded so a reply to the reminder continues the thread.
    expect(mockRecordTelegramJobOutput).toHaveBeenCalledWith({
      userId,
      telegramChatId: chatId,
      content: "Dentist in 30 minutes",
    });
  });

  it("surfaces a rejected send with the provider's reason", async () => {
    mockTelegramAccount.findUnique.mockResolvedValue({
      id: "acc-1",
      encryptedToken: "enc",
      enabled: true,
      notifyChatId: null,
    });
    mockResolveNotifyChat.mockResolvedValue({ chatId, label: "Jane", source: "private" });
    mockSendTelegramMessage.mockRejectedValue(new Error("Forbidden: bot was blocked by the user"));

    const result = await sendTelegramToUser({ userId, content: "hello" });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("send_failed");
    expect(result.error).toContain("blocked by the user");
  });

  it("delivers even when recording the message for replies fails", async () => {
    mockTelegramAccount.findUnique.mockResolvedValue({
      id: "acc-1",
      encryptedToken: "enc",
      enabled: true,
      notifyChatId: null,
    });
    mockResolveNotifyChat.mockResolvedValue({ chatId, label: "Jane", source: "private" });
    mockRecordTelegramJobOutput.mockRejectedValue(new Error("db down"));

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
  beforeEach(() => {
    vi.clearAllMocks();
    mockRecordTelegramJobOutput.mockResolvedValue(undefined);
    mockSendTelegramMessage.mockResolvedValue([42]);
  });

  it("sends and records the message for reply context", async () => {
    const result = await deliverTelegramMessage({
      userId,
      encryptedToken: "enc",
      chatId,
      content: "hello",
    });

    expect(result).toEqual({ ok: true, chatId: "119075844" });
    expect(mockSendTelegramMessage).toHaveBeenCalledWith("enc", chatId, "hello");
    expect(mockRecordTelegramJobOutput).toHaveBeenCalledWith({
      userId,
      telegramChatId: chatId,
      content: "hello",
    });
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
