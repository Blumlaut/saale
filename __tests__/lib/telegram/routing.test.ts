import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks ───────────────────────────────────────────────────────────────────

const { mockGetLinkByUserId, mockFindOutboundSource, mockChatSession, mockCreateChatSessionRow } =
  vi.hoisted(() => ({
    mockGetLinkByUserId: vi.fn(),
    mockFindOutboundSource: vi.fn(),
    mockChatSession: { findFirst: vi.fn() },
    mockCreateChatSessionRow: vi.fn(),
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

vi.mock("@/lib/chat/create-session", () => ({
  createChatSessionRow: (...args: unknown[]) => mockCreateChatSessionRow(...args),
}));

import {
  resolveExistingTelegramTarget,
  resolveOrStartTelegramTarget,
  resolveTelegramTarget,
} from "@/lib/telegram/routing";

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
  mockFindOutboundSource.mockResolvedValue({ kind: "unknown" });
  mockChatSession.findFirst.mockResolvedValue({ id: "sess-x" });
  mockCreateChatSessionRow.mockResolvedValue({ id: "sess-new", title: "New Chat" });
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("resolveTelegramTarget", () => {
  it("continues the chat that sent the replied-to message", async () => {
    mockFindOutboundSource.mockResolvedValue({ kind: "chat", sessionId: "sess-source" });

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
    mockFindOutboundSource.mockResolvedValue({ kind: "chat", sessionId: "sess-quoted" });

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

  it("starts a chat when the answered message's chat was deleted", async () => {
    mockGetLinkByUserId.mockResolvedValue({ ...link, activeSessionId: "sess-active" });
    mockFindOutboundSource.mockResolvedValue({ kind: "chat", sessionId: "sess-gone" });
    mockChatSession.findFirst.mockResolvedValue(null);

    const target = await resolveTelegramTarget({
      userId,
      telegramChatId: chatId,
      replyToMessageId: BigInt(42),
    });

    // The chat it answers is gone, so the answer joins none of the others.
    expect(target).toBeNull();
  });

  it("starts a chat when the answered message came from no chat", async () => {
    // A watcher's message has no chat behind it. Answering it must not drop the
    // answer into whatever chat the user last spoke in.
    mockGetLinkByUserId.mockResolvedValue({ ...link, activeSessionId: "sess-unsloth" });
    mockFindOutboundSource.mockResolvedValue({ kind: "no_chat" });

    const target = await resolveTelegramTarget({
      userId,
      telegramChatId: chatId,
      replyToMessageId: BigInt(42),
    });

    expect(target).toBeNull();
  });

  it("opens a new chat for a watcher reply instead of joining the open one", async () => {
    mockGetLinkByUserId.mockResolvedValue({ ...link, activeSessionId: "sess-unsloth" });
    mockFindOutboundSource.mockResolvedValue({ kind: "no_chat" });

    const target = await resolveOrStartTelegramTarget({
      userId,
      telegramChatId: chatId,
      replyToMessageId: BigInt(42),
    });

    expect(target).toEqual({ sessionId: "sess-new", via: "new" });
    expect(mockCreateChatSessionRow).toHaveBeenCalledWith(userId);
  });

  it("continues the open chat when the answered message is not on record", async () => {
    mockGetLinkByUserId.mockResolvedValue({ ...link, activeSessionId: "sess-active" });
    mockFindOutboundSource.mockResolvedValue({ kind: "unknown" });

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

describe("resolveOrStartTelegramTarget", () => {
  it("starts a chat when nothing resolves, so a message needs no /new", async () => {
    const target = await resolveOrStartTelegramTarget({ userId, telegramChatId: chatId });

    expect(target).toEqual({ sessionId: "sess-new", via: "new" });
    expect(mockCreateChatSessionRow).toHaveBeenCalledWith(userId);
  });

  it("keeps the chat a message continues instead of starting another", async () => {
    mockGetLinkByUserId.mockResolvedValue({ ...link, activeSessionId: "sess-active" });

    const target = await resolveOrStartTelegramTarget({ userId, telegramChatId: chatId });

    expect(target).toEqual({ sessionId: "sess-active", via: "active" });
    expect(mockCreateChatSessionRow).not.toHaveBeenCalled();
  });

  it("starts a chat when the answered message's chat is gone", async () => {
    mockFindOutboundSource.mockResolvedValue({ kind: "chat", sessionId: "sess-gone" });
    mockChatSession.findFirst.mockResolvedValue(null);

    const target = await resolveOrStartTelegramTarget({
      userId,
      telegramChatId: chatId,
      replyToMessageId: BigInt(42),
    });

    expect(target).toEqual({ sessionId: "sess-new", via: "new" });
    expect(mockCreateChatSessionRow).toHaveBeenCalledWith(userId);
  });

  it("continues the answered message's chat when the user still owns it", async () => {
    mockFindOutboundSource.mockResolvedValue({ kind: "chat", sessionId: "sess-source" });

    const target = await resolveOrStartTelegramTarget({
      userId,
      telegramChatId: chatId,
      replyToMessageId: BigInt(42),
    });

    expect(target).toEqual({ sessionId: "sess-source", via: "reply" });
    expect(mockCreateChatSessionRow).not.toHaveBeenCalled();
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

  it("starts no chat for a reply whose chat is gone", async () => {
    // A command acts on a chat. it never opens one.
    mockFindOutboundSource.mockResolvedValue({ kind: "chat", sessionId: "sess-gone" });
    mockChatSession.findFirst.mockResolvedValue(null);

    const sessionId = await resolveExistingTelegramTarget({
      userId,
      telegramChatId: chatId,
      replyToMessageId: BigInt(42),
    });

    expect(sessionId).toBeNull();
    expect(mockCreateChatSessionRow).not.toHaveBeenCalled();
  });

  it("acts on nothing for a command that answers a chat-less message", async () => {
    mockGetLinkByUserId.mockResolvedValue({ ...link, activeSessionId: "sess-unsloth" });
    mockFindOutboundSource.mockResolvedValue({ kind: "no_chat" });

    const sessionId = await resolveExistingTelegramTarget({
      userId,
      telegramChatId: chatId,
      replyToMessageId: BigInt(42),
    });

    expect(sessionId).toBeNull();
  });
});
