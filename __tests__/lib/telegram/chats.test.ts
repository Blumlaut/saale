import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks ───────────────────────────────────────────────────────────────────

const {
  mockFindMany,
  mockFindUnique,
  mockUpdate,
  mockDeleteMany,
  mockGetTelegramBot,
  mockGetLinkByUserId,
  mockGetTelegramChatInfo,
  mockLeaveTelegramChat,
} = vi.hoisted(() => ({
  mockFindMany: vi.fn(),
  mockFindUnique: vi.fn(),
  mockUpdate: vi.fn(),
  mockDeleteMany: vi.fn(),
  mockGetTelegramBot: vi.fn(),
  mockGetLinkByUserId: vi.fn(),
  mockGetTelegramChatInfo: vi.fn(),
  mockLeaveTelegramChat: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    telegramChat: {
      findMany: (...args: unknown[]) => mockFindMany(...args),
      findUnique: (...args: unknown[]) => mockFindUnique(...args),
      update: (...args: unknown[]) => mockUpdate(...args),
      deleteMany: (...args: unknown[]) => mockDeleteMany(...args),
    },
  },
}));

vi.mock("@/lib/telegram/bot", () => ({
  TELEGRAM_BOT_ID: "global",
  getTelegramBot: (...args: unknown[]) => mockGetTelegramBot(...args),
}));

vi.mock("@/lib/telegram/links", () => ({
  getLinkByUserId: (...args: unknown[]) => mockGetLinkByUserId(...args),
}));

vi.mock("@/lib/telegram/client", () => ({
  getTelegramChatInfo: (...args: unknown[]) => mockGetTelegramChatInfo(...args),
  leaveTelegramChat: (...args: unknown[]) => mockLeaveTelegramChat(...args),
}));

const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

import {
  listTelegramChats,
  removeTelegramChat,
  resolveTelegramSendTarget,
  TelegramTargetError,
  toChatView,
} from "@/lib/telegram/chats";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const userId = "user-1";
const otherUserId = "user-2";
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

const link = {
  id: "link-1",
  userId,
  telegramUserId: BigInt("119075844"),
  telegramChatId: BigInt("119075844"),
  displayName: "Jane",
  sessionId: null,
  activeSessionId: null,
  createdAt: new Date("2026-02-01T00:00:00.000Z"),
  updatedAt: new Date("2026-02-01T00:00:00.000Z"),
};

const DAY = 24 * 60 * 60 * 1000;

function chatRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "chat-row-1",
    botId: "global",
    ownerUserId: userId,
    chatId: BigInt("-1001234567890"),
    title: "CVEs",
    kind: "supergroup",
    memberCount: 42,
    enabled: true,
    syncedAt: new Date("2026-02-01T00:00:00.000Z"),
    createdAt: new Date("2026-02-01T00:00:00.000Z"),
    updatedAt: new Date("2026-02-01T00:00:00.000Z"),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetTelegramBot.mockResolvedValue(bot);
  mockGetLinkByUserId.mockResolvedValue(link);
  mockFindMany.mockResolvedValue([]);
  mockFindUnique.mockResolvedValue(null);
  mockDeleteMany.mockResolvedValue({ count: 0 });
  mockLeaveTelegramChat.mockResolvedValue(undefined);
});

// ─── Target resolution ───────────────────────────────────────────────────────

describe("resolveTelegramSendTarget", () => {
  it("defaults to the user's own linked chat", async () => {
    const target = await resolveTelegramSendTarget({ userId });

    expect(target).toEqual({ chatId: link.telegramChatId, label: "Jane", group: false });
  });

  it("accepts a group the caller owns", async () => {
    mockFindUnique.mockResolvedValue(chatRow());

    const target = await resolveTelegramSendTarget({ userId, target: "-1001234567890" });

    expect(target).toEqual({
      chatId: BigInt("-1001234567890"),
      label: "CVEs",
      group: true,
    });
    expect(mockFindUnique).toHaveBeenCalledWith({ where: { chatId: BigInt("-1001234567890") } });
  });

  it("refuses a group that belongs to someone else", async () => {
    mockFindUnique.mockResolvedValue(chatRow({ ownerUserId: otherUserId }));
    mockFindMany.mockResolvedValue([{ chatId: BigInt("-1001234567890"), title: "CVEs" }]);

    const error = await resolveTelegramSendTarget({ userId, target: "-1001234567890" }).catch(
      (err: unknown) => err,
    );

    // Ownership is checked against the caller, not just the row's existence.
    expect(error).toBeInstanceOf(TelegramTargetError);
    expect((error as Error).message).toContain("CVEs");
  });

  it("names the available groups so a wrong id is correctable", async () => {
    mockFindMany.mockResolvedValue([
      { chatId: BigInt("-1001234567890"), title: "CVEs" },
      { chatId: BigInt("-1009876543210"), title: "Alerts" },
    ]);

    await expect(resolveTelegramSendTarget({ userId, target: "-1009999999999" })).rejects.toThrow(
      /"CVEs" \(-1001234567890\), "Alerts" \(-1009876543210\)/,
    );
  });

  it("says there is nowhere but the private chat when no groups exist", async () => {
    await expect(resolveTelegramSendTarget({ userId, target: "-1001234567890" })).rejects.toThrow(
      /only target is the user's own chat/,
    );
  });

  it("refuses a target that is not a chat id at all", async () => {
    await expect(resolveTelegramSendTarget({ userId, target: "CVEs" })).rejects.toThrow(
      TelegramTargetError,
    );
    expect(mockFindUnique).not.toHaveBeenCalled();
  });

  it("refuses a group the bot has left", async () => {
    mockFindUnique.mockResolvedValue(chatRow({ enabled: false }));

    await expect(resolveTelegramSendTarget({ userId, target: "-1001234567890" })).rejects.toThrow(
      /no longer in "CVEs"/,
    );
  });

  it("refuses a private delivery when the account is unlinked", async () => {
    mockGetLinkByUserId.mockResolvedValue(null);

    await expect(resolveTelegramSendTarget({ userId })).rejects.toThrow(/Integrations/);
  });
});

// ─── Listing ─────────────────────────────────────────────────────────────────

describe("listTelegramChats", () => {
  it("scopes the list to the caller", async () => {
    mockFindMany.mockResolvedValue([chatRow()]);

    await listTelegramChats(userId);

    expect(mockFindMany).toHaveBeenCalledWith({
      where: { ownerUserId: userId },
      orderBy: { createdAt: "asc" },
    });
  });

  it("refreshes a group whose metadata has aged out", async () => {
    const stale = chatRow({ title: "Old name", syncedAt: new Date(Date.now() - 2 * DAY) });
    mockFindMany.mockResolvedValue([stale]);
    mockGetTelegramChatInfo.mockResolvedValue({
      chatId: stale.chatId,
      title: "New name",
      kind: "supergroup",
      memberCount: 50,
    });
    mockUpdate.mockResolvedValue({ ...stale, title: "New name", memberCount: 50 });

    const chats = await listTelegramChats(userId);

    expect(mockGetTelegramChatInfo).toHaveBeenCalledWith("enc", stale.chatId);
    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: stale.id },
      data: {
        title: "New name",
        kind: "supergroup",
        memberCount: 50,
        syncedAt: expect.any(Date),
      },
    });
    expect(chats[0]!.title).toBe("New name");
  });

  it("keeps the cached title when Telegram refuses getChat", async () => {
    const stale = chatRow({ title: "Cached", syncedAt: new Date(Date.now() - 2 * DAY) });
    mockFindMany.mockResolvedValue([stale]);
    mockGetTelegramChatInfo.mockRejectedValue(new Error("chat not found"));

    const chats = await listTelegramChats(userId);

    expect(chats[0]!.title).toBe("Cached");
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to refresh group"),
      expect.any(Error),
    );
  });

  it("does not call Telegram for a group refreshed within the day", async () => {
    mockFindMany.mockResolvedValue([chatRow({ syncedAt: new Date() })]);

    await listTelegramChats(userId);

    expect(mockGetTelegramChatInfo).not.toHaveBeenCalled();
  });

  it("does not call Telegram at all when the bot is switched off", async () => {
    mockFindMany.mockResolvedValue([chatRow({ syncedAt: null })]);
    mockGetTelegramBot.mockResolvedValue({ ...bot, enabled: false });

    await listTelegramChats(userId);

    expect(mockGetTelegramChatInfo).not.toHaveBeenCalled();
  });
});

// ─── Removal ─────────────────────────────────────────────────────────────────

describe("removeTelegramChat", () => {
  it("deletes the row and leaves the group", async () => {
    mockDeleteMany.mockResolvedValue({ count: 1 });

    const removed = await removeTelegramChat({
      ownerUserId: userId,
      chatId: BigInt("-1001234567890"),
    });

    expect(removed).toBe(true);
    expect(mockDeleteMany).toHaveBeenCalledWith({
      where: { ownerUserId: userId, chatId: BigInt("-1001234567890") },
    });
    expect(mockLeaveTelegramChat).toHaveBeenCalledWith("enc", BigInt("-1001234567890"));
  });

  it("does not leave a group it never removed", async () => {
    mockDeleteMany.mockResolvedValue({ count: 0 });

    const removed = await removeTelegramChat({
      ownerUserId: otherUserId,
      chatId: BigInt("-1001234567890"),
    });

    expect(removed).toBe(false);
    expect(mockLeaveTelegramChat).not.toHaveBeenCalled();
  });

  it("keeps the removal when leaving fails", async () => {
    mockDeleteMany.mockResolvedValue({ count: 1 });
    mockLeaveTelegramChat.mockRejectedValue(new Error("bot is not a member"));

    const removed = await removeTelegramChat({
      ownerUserId: userId,
      chatId: BigInt("-1001234567890"),
    });

    // A leave Telegram refuses must not leave a target that can never deliver.
    expect(removed).toBe(true);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to leave chat"),
      expect.any(Error),
    );
  });
});

describe("toChatView", () => {
  it("sends the chat id as a string and keeps the rest", () => {
    expect(toChatView(chatRow())).toEqual({
      chatId: "-1001234567890",
      title: "CVEs",
      kind: "supergroup",
      memberCount: 42,
      enabled: true,
    });
  });
});
