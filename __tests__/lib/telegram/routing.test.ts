import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks ───────────────────────────────────────────────────────────────────

const { mockGetLinkByUserId, mockFindOutboundSource, mockChatSession, mockChatMessage, mockTx } =
  vi.hoisted(() => ({
    mockGetLinkByUserId: vi.fn(),
    mockFindOutboundSource: vi.fn(),
    mockChatSession: { findFirst: vi.fn(), create: vi.fn() },
    mockChatMessage: { findMany: vi.fn() },
    mockTx: vi.fn(),
  }));

vi.mock("@/lib/db", () => ({
  prisma: {
    chatSession: mockChatSession,
    chatMessage: mockChatMessage,
    $transaction: (...args: unknown[]) => mockTx(...args),
  },
}));

vi.mock("@/lib/telegram/links", () => ({
  getLinkByUserId: (...args: unknown[]) => mockGetLinkByUserId(...args),
}));

vi.mock("@/lib/telegram/outbound-messages", () => ({
  findOutboundSource: (...args: unknown[]) => mockFindOutboundSource(...args),
}));

import { resolveTelegramTarget } from "@/lib/telegram/routing";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const userId = "user-1";
const chatId = BigInt("119075844");

const link = {
  id: "link-1",
  userId,
  telegramUserId: chatId,
  telegramChatId: chatId,
  displayName: "Jane",
  sessionId: "sess-home",
  lastOutboundSessionId: null as string | null,
  createdAt: new Date("2026-02-01T00:00:00.000Z"),
  updatedAt: new Date("2026-02-01T00:00:00.000Z"),
};

/** The home thread looks alive: it has a fresh message. */
const freshMessage = [{ createdAt: new Date() }];

beforeEach(() => {
  vi.resetAllMocks();
  mockGetLinkByUserId.mockResolvedValue(link);
  mockFindOutboundSource.mockResolvedValue(null);
  mockChatSession.findFirst.mockResolvedValue({ id: "sess-x" });
  mockChatMessage.findMany.mockResolvedValue(freshMessage);
  mockTx.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      chatSession: { create: mockChatSession.create },
      telegramLink: { update: vi.fn() },
    }),
  );
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("resolveTelegramTarget", () => {
  it("continues the chat that sent the replied-to message", async () => {
    mockFindOutboundSource.mockResolvedValue("sess-source");

    const target = await resolveTelegramTarget({
      userId,
      telegramChatId: chatId,
      replyToMessageId: BigInt(42),
    });

    expect(target).toEqual({ sessionId: "sess-source", via: "reply" });
    expect(mockFindOutboundSource).toHaveBeenCalledWith({
      userId,
      chatId,
      messageId: BigInt(42),
    });
  });

  it("ignores a reply to a message it did not send and uses the last chat that spoke", async () => {
    mockGetLinkByUserId.mockResolvedValue({ ...link, lastOutboundSessionId: "sess-last" });

    const target = await resolveTelegramTarget({
      userId,
      telegramChatId: chatId,
      replyToMessageId: BigInt(1),
    });

    expect(target).toEqual({ sessionId: "sess-last", via: "last_sent" });
  });

  it("falls back to the last chat that sent a message when nothing is quoted", async () => {
    mockGetLinkByUserId.mockResolvedValue({ ...link, lastOutboundSessionId: "sess-last" });

    const target = await resolveTelegramTarget({ userId, telegramChatId: chatId });

    expect(target).toEqual({ sessionId: "sess-last", via: "last_sent" });
  });

  it("falls through to the home thread when the recorded chat was deleted", async () => {
    mockGetLinkByUserId.mockResolvedValue({ ...link, lastOutboundSessionId: "sess-gone" });
    mockChatSession.findFirst.mockResolvedValue(null);

    const target = await resolveTelegramTarget({ userId, telegramChatId: chatId });

    expect(target).toEqual({ sessionId: "sess-home", via: "home" });
  });

  it("falls through to the home thread when the replied-to chat was deleted", async () => {
    mockFindOutboundSource.mockResolvedValue("sess-gone");
    mockChatSession.findFirst.mockResolvedValue(null);

    const target = await resolveTelegramTarget({
      userId,
      telegramChatId: chatId,
      replyToMessageId: BigInt(42),
    });

    expect(target).toEqual({ sessionId: "sess-home", via: "home" });
  });

  it("uses the link's home thread when it is still fresh", async () => {
    const target = await resolveTelegramTarget({ userId, telegramChatId: chatId });

    expect(target).toEqual({ sessionId: "sess-home", via: "home" });
    expect(mockChatSession.create).not.toHaveBeenCalled();
  });

  it("starts a new home thread when the old one expired", async () => {
    mockChatMessage.findMany.mockResolvedValue([
      { createdAt: new Date(Date.now() - 7 * 60 * 60 * 1000) },
    ]);

    const target = await resolveTelegramTarget({ userId, telegramChatId: chatId });

    expect(target.via).toBe("home");
    expect(target.sessionId).not.toBe("sess-home");
    expect(mockChatSession.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ userId, title: "Telegram Chat", temporary: false }),
    });
  });

  it("refuses a chat that is not this link's", async () => {
    await expect(resolveTelegramTarget({ userId, telegramChatId: BigInt(999) })).rejects.toThrow(
      "does not belong to this user's link",
    );
  });

  it("refuses an unlinked user", async () => {
    mockGetLinkByUserId.mockResolvedValue(null);

    await expect(resolveTelegramTarget({ userId, telegramChatId: chatId })).rejects.toThrow(
      "Telegram link not found",
    );
  });
});
