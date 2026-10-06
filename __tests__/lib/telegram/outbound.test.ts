import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks ───────────────────────────────────────────────────────────────────

const {
  mockTelegramAccount,
  mockTelegramChat,
  mockChatMessage,
  mockChatSession,
  mockAppendCustomMessageEntry,
  mockContinueRecent,
} = vi.hoisted(() => ({
  mockTelegramAccount: { findUnique: vi.fn() },
  mockTelegramChat: { findUnique: vi.fn() },
  mockChatMessage: { create: vi.fn() },
  mockChatSession: { update: vi.fn() },
  mockAppendCustomMessageEntry: vi.fn(),
  mockContinueRecent: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    telegramAccount: mockTelegramAccount,
    telegramChat: mockTelegramChat,
    chatMessage: mockChatMessage,
    chatSession: mockChatSession,
  },
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  SessionManager: {
    continueRecent: (...args: unknown[]) => mockContinueRecent(...args),
  },
}));

import { recordTelegramJobOutput } from "@/lib/telegram/outbound";

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("recordTelegramJobOutput", () => {
  const userId = "user-1";
  const chatId = BigInt("119075844");

  beforeEach(() => {
    vi.resetAllMocks();
    mockTelegramAccount.findUnique.mockResolvedValue({ id: "acc-1" });
    mockTelegramChat.findUnique.mockResolvedValue({ sessionId: "sess-1" });
    mockChatMessage.create.mockResolvedValue({ id: "msg-1" });
    mockChatSession.update.mockResolvedValue({});
    mockContinueRecent.mockReturnValue({
      appendCustomMessageEntry: mockAppendCustomMessageEntry,
    });
  });

  it("persists the message to the chat session and the Pi transcript", async () => {
    await recordTelegramJobOutput({
      userId,
      telegramChatId: chatId,
      content: "Daily digest ready",
    });

    expect(mockChatMessage.create).toHaveBeenCalledWith({
      data: { sessionId: "sess-1", role: "assistant", content: "Daily digest ready" },
    });
    expect(mockChatSession.update).toHaveBeenCalledWith({
      where: { id: "sess-1" },
      data: { lastActivityAt: expect.any(Date) },
    });

    // The Pi transcript entry is what gives the agent memory of the message.
    expect(mockAppendCustomMessageEntry).toHaveBeenCalledWith(
      "job_output",
      expect.stringContaining("Daily digest ready"),
      false,
      expect.objectContaining({ channel: "telegram" }),
    );
  });

  it("no-ops for blank content", async () => {
    await recordTelegramJobOutput({ userId, telegramChatId: chatId, content: "   " });

    expect(mockTelegramAccount.findUnique).not.toHaveBeenCalled();
    expect(mockChatMessage.create).not.toHaveBeenCalled();
  });

  it("no-ops when the user has no Telegram account", async () => {
    mockTelegramAccount.findUnique.mockResolvedValue(null);

    await recordTelegramJobOutput({ userId, telegramChatId: chatId, content: "hi" });

    expect(mockChatMessage.create).not.toHaveBeenCalled();
    expect(mockContinueRecent).not.toHaveBeenCalled();
  });

  it("no-ops when the chat has never messaged the bot (no session to attach to)", async () => {
    mockTelegramChat.findUnique.mockResolvedValue(null);

    await recordTelegramJobOutput({ userId, telegramChatId: chatId, content: "hi" });

    expect(mockChatMessage.create).not.toHaveBeenCalled();
    expect(mockContinueRecent).not.toHaveBeenCalled();
  });

  it("surfaces a transcript-append failure after the DB half is written", async () => {
    mockAppendCustomMessageEntry.mockImplementation(() => {
      throw new Error("transcript write failed");
    });

    await expect(
      recordTelegramJobOutput({ userId, telegramChatId: chatId, content: "hi" }),
    ).rejects.toThrow("transcript write failed");

    // The DB half already landed before the transcript append failed.
    expect(mockChatMessage.create).toHaveBeenCalled();
  });

  it("scopes the chat lookup by account and chat ID", async () => {
    await recordTelegramJobOutput({ userId, telegramChatId: chatId, content: "hi" });

    expect(mockTelegramChat.findUnique).toHaveBeenCalledWith({
      where: {
        telegramAccountId_telegramChatId: { telegramAccountId: "acc-1", telegramChatId: chatId },
      },
      select: { sessionId: true },
    });
  });
});
