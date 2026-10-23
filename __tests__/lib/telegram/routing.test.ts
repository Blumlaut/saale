import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks ───────────────────────────────────────────────────────────────────

const { mockGetLinkByUserId, mockFindOutboundSource, mockChatSession } = vi.hoisted(() => ({
  mockGetLinkByUserId: vi.fn(),
  mockFindOutboundSource: vi.fn(),
  mockChatSession: { findFirst: vi.fn() },
}));

vi.mock("@/lib/db", () => ({
  prisma: { chatSession: mockChatSession },
}));

vi.mock("@/lib/telegram/links", () => ({
  getLinkByUserId: (...args: unknown[]) => mockGetLinkByUserId(...args),
}));

vi.mock("@/lib/telegram/outbound-messages", () => ({
  findOutboundSource: (...args: unknown[]) => mockFindOutboundSource(...args),
}));

import { resolveExistingTelegramTarget, resolveTelegramTarget } from "@/lib/telegram/routing";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const userId = "user-1";
const chatId = BigInt("119075844");

const link = {
  id: "link-1",
  userId,
  telegramUserId: chatId,
  telegramChatId: chatId,
  displayName: "Jane",
  activeSessionId: null as string | null,
  createdAt: new Date("2026-02-01T00:00:00.000Z"),
  updatedAt: new Date("2026-02-01T00:00:00.000Z"),
};

beforeEach(() => {
  vi.resetAllMocks();
  mockGetLinkByUserId.mockResolvedValue(link);
  mockFindOutboundSource.mockResolvedValue(null);
  mockChatSession.findFirst.mockResolvedValue({ id: "sess-x" });
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

  it("continues the chat this conversation is in when nothing is quoted", async () => {
    mockGetLinkByUserId.mockResolvedValue({ ...link, activeSessionId: "sess-active" });

    const target = await resolveTelegramTarget({ userId, telegramChatId: chatId });

    expect(target).toEqual({ sessionId: "sess-active", via: "active" });
  });

  it("prefers the quoted message over the active chat", async () => {
    mockGetLinkByUserId.mockResolvedValue({ ...link, activeSessionId: "sess-active" });
    mockFindOutboundSource.mockResolvedValue("sess-quoted");

    const target = await resolveTelegramTarget({
      userId,
      telegramChatId: chatId,
      replyToMessageId: BigInt(42),
    });

    expect(target).toEqual({ sessionId: "sess-quoted", via: "reply" });
  });

  it("returns null when the message belongs to no chat", async () => {
    const target = await resolveTelegramTarget({ userId, telegramChatId: chatId });

    // There is no chat of the bot's own to invent. the caller says so.
    expect(target).toBeNull();
    expect(mockChatSession.findFirst).not.toHaveBeenCalled();
  });

  it("returns null when the recorded chat was deleted", async () => {
    mockGetLinkByUserId.mockResolvedValue({ ...link, activeSessionId: "sess-gone" });
    mockChatSession.findFirst.mockResolvedValue(null);

    const target = await resolveTelegramTarget({ userId, telegramChatId: chatId });

    expect(target).toBeNull();
  });

  it("ignores a reply whose chat was deleted, and falls back to the active chat", async () => {
    mockGetLinkByUserId.mockResolvedValue({ ...link, activeSessionId: "sess-active" });
    mockFindOutboundSource.mockResolvedValue("sess-gone");
    mockChatSession.findFirst.mockImplementation(async ({ where }: { where: { id: string } }) =>
      where.id === "sess-active" ? { id: "sess-active" } : null,
    );

    const target = await resolveTelegramTarget({
      userId,
      telegramChatId: chatId,
      replyToMessageId: BigInt(42),
    });

    expect(target).toEqual({ sessionId: "sess-active", via: "active" });
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

describe("resolveExistingTelegramTarget", () => {
  it("returns the chat a command acts on without creating one", async () => {
    mockGetLinkByUserId.mockResolvedValue({ ...link, activeSessionId: "sess-active" });

    const sessionId = await resolveExistingTelegramTarget({ userId, telegramChatId: chatId });

    expect(sessionId).toBe("sess-active");
  });

  it("returns null when there is no conversation yet", async () => {
    const sessionId = await resolveExistingTelegramTarget({ userId, telegramChatId: chatId });

    expect(sessionId).toBeNull();
  });
});
