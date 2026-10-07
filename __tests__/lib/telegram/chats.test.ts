import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks ───────────────────────────────────────────────────────────────────

const { mockTelegramChat, mockTelegramWhitelist } = vi.hoisted(() => ({
  mockTelegramChat: { findFirst: vi.fn(), findMany: vi.fn(), findUnique: vi.fn() },
  mockTelegramWhitelist: { findFirst: vi.fn(), findUnique: vi.fn(), findMany: vi.fn() },
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    telegramChat: mockTelegramChat,
    telegramWhitelist: mockTelegramWhitelist,
  },
}));

import {
  resolveDefaultTelegramChat,
  getDefaultTelegramChatInfo,
  listTelegramChats,
  resolveNotifyChat,
  isKnownTelegramChat,
} from "@/lib/telegram/chats";

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("resolveDefaultTelegramChat", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the most recently active TelegramChat when one exists", async () => {
    mockTelegramChat.findFirst.mockResolvedValue({ telegramChatId: BigInt("119075844") });

    const result = await resolveDefaultTelegramChat("acc-1");

    expect(result).toBe(BigInt("119075844"));
    expect(mockTelegramChat.findFirst).toHaveBeenCalledWith({
      where: { telegramAccountId: "acc-1" },
      select: { telegramChatId: true },
      orderBy: { updatedAt: "desc" },
    });
    expect(mockTelegramWhitelist.findFirst).not.toHaveBeenCalled();
  });

  it("falls back to the most recently whitelisted user ID when no chat exists", async () => {
    mockTelegramChat.findFirst.mockResolvedValue(null);
    mockTelegramWhitelist.findFirst.mockResolvedValue({ telegramUserId: BigInt("119075844") });

    const result = await resolveDefaultTelegramChat("acc-1");

    expect(result).toBe(BigInt("119075844"));
    expect(mockTelegramWhitelist.findFirst).toHaveBeenCalledWith({
      where: { telegramAccountId: "acc-1" },
      select: { telegramUserId: true },
      orderBy: { createdAt: "desc" },
    });
  });

  it("returns null when neither a chat nor a whitelist entry exists", async () => {
    mockTelegramChat.findFirst.mockResolvedValue(null);
    mockTelegramWhitelist.findFirst.mockResolvedValue(null);

    const result = await resolveDefaultTelegramChat("acc-1");

    expect(result).toBeNull();
  });
});

describe("getDefaultTelegramChatInfo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the chat ID and whitelist display name as the label", async () => {
    mockTelegramChat.findFirst.mockResolvedValue({ telegramChatId: BigInt("119075844") });
    mockTelegramWhitelist.findUnique.mockResolvedValue({ displayName: "Jane" });

    const result = await getDefaultTelegramChatInfo("acc-1");

    expect(result).toEqual({ chatId: "119075844", label: "Jane" });
    expect(mockTelegramWhitelist.findUnique).toHaveBeenCalledWith({
      where: {
        telegramAccountId_telegramUserId: {
          telegramAccountId: "acc-1",
          telegramUserId: BigInt("119075844"),
        },
      },
      select: { displayName: true },
    });
  });

  it("labels a chat without a whitelist match as 'Configured chat'", async () => {
    mockTelegramChat.findFirst.mockResolvedValue({ telegramChatId: BigInt("119075844") });
    mockTelegramWhitelist.findUnique.mockResolvedValue(null);

    const result = await getDefaultTelegramChatInfo("acc-1");

    expect(result).toEqual({ chatId: "119075844", label: "Configured chat" });
  });

  it("returns null when nothing is configured", async () => {
    mockTelegramChat.findFirst.mockResolvedValue(null);
    mockTelegramWhitelist.findFirst.mockResolvedValue(null);

    const result = await getDefaultTelegramChatInfo("acc-1");

    expect(result).toBeNull();
  });
});

describe("listTelegramChats", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lists chats most recent first with whitelist names for private chats", async () => {
    mockTelegramChat.findMany.mockResolvedValue([
      { telegramChatId: BigInt("119075844"), chatType: "private" },
      { telegramChatId: BigInt("-100123456789"), chatType: "group" },
    ]);
    mockTelegramWhitelist.findMany.mockResolvedValue([
      { telegramUserId: BigInt("119075844"), displayName: "Jane" },
    ]);

    const result = await listTelegramChats("acc-1");

    expect(result).toEqual([
      { chatId: "119075844", label: "Jane", chatType: "private" },
      { chatId: "-100123456789", label: "Group chat", chatType: "group" },
    ]);
  });

  it("returns an empty list when there are no chats", async () => {
    mockTelegramChat.findMany.mockResolvedValue([]);
    mockTelegramWhitelist.findMany.mockResolvedValue([]);

    const result = await listTelegramChats("acc-1");

    expect(result).toEqual([]);
  });
});

// ─── Proactive delivery target ───────────────────────────────────────────────

describe("resolveNotifyChat", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the pinned chat without consulting any other source", async () => {
    mockTelegramWhitelist.findUnique.mockResolvedValue({ displayName: "Jane" });

    const result = await resolveNotifyChat("acc-1", BigInt("119075844"));

    expect(result).toEqual({
      chatId: BigInt("119075844"),
      label: "Jane",
      source: "pinned",
    });
    expect(mockTelegramChat.findFirst).not.toHaveBeenCalled();
  });

  it("allows pinning a group, since that is an explicit choice", async () => {
    mockTelegramWhitelist.findUnique.mockResolvedValue(null);

    const result = await resolveNotifyChat("acc-1", BigInt("-100123456789"));

    expect(result?.chatId).toBe(BigInt("-100123456789"));
    expect(result?.source).toBe("pinned");
  });

  it("prefers a private chat over the most recently active group", async () => {
    // The group is newer, but a message meant for the owner must not land in it.
    mockTelegramChat.findFirst.mockResolvedValue({ telegramChatId: BigInt("119075844") });
    mockTelegramWhitelist.findUnique.mockResolvedValue({ displayName: "Jane" });

    const result = await resolveNotifyChat("acc-1", null);

    expect(result).toEqual({
      chatId: BigInt("119075844"),
      label: "Jane",
      source: "private",
    });
    expect(mockTelegramChat.findFirst).toHaveBeenCalledWith({
      where: { telegramAccountId: "acc-1", chatType: "private" },
      select: { telegramChatId: true },
      orderBy: { updatedAt: "desc" },
    });
  });

  it("falls back to the most recently whitelisted user when no chat exists", async () => {
    mockTelegramChat.findFirst.mockResolvedValue(null);
    mockTelegramWhitelist.findFirst.mockResolvedValue({
      telegramUserId: BigInt("119075844"),
      displayName: "Jane",
    });

    const result = await resolveNotifyChat("acc-1", null);

    expect(result).toEqual({
      chatId: BigInt("119075844"),
      label: "Jane",
      source: "whitelist",
    });
  });

  it("labels a whitelisted user with no name generically", async () => {
    mockTelegramChat.findFirst.mockResolvedValue(null);
    mockTelegramWhitelist.findFirst.mockResolvedValue({
      telegramUserId: BigInt("119075844"),
      displayName: null,
    });

    const result = await resolveNotifyChat("acc-1", null);

    expect(result?.label).toBe("Whitelisted user");
  });

  it("returns null when the account knows no chat at all", async () => {
    mockTelegramChat.findFirst.mockResolvedValue(null);
    mockTelegramWhitelist.findFirst.mockResolvedValue(null);

    const result = await resolveNotifyChat("acc-1", null);

    expect(result).toBeNull();
  });
});

describe("isKnownTelegramChat", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("accepts a chat the bot has been in", async () => {
    mockTelegramChat.findUnique.mockResolvedValue({ id: "chat-1" });
    mockTelegramWhitelist.findUnique.mockResolvedValue(null);

    expect(await isKnownTelegramChat("acc-1", BigInt("119075844"))).toBe(true);
  });

  it("accepts a whitelisted user that has never messaged the bot", async () => {
    mockTelegramChat.findUnique.mockResolvedValue(null);
    mockTelegramWhitelist.findUnique.mockResolvedValue({ id: "wl-1" });

    expect(await isKnownTelegramChat("acc-1", BigInt("119075844"))).toBe(true);
  });

  it("rejects a chat the account has never seen", async () => {
    mockTelegramChat.findUnique.mockResolvedValue(null);
    mockTelegramWhitelist.findUnique.mockResolvedValue(null);

    expect(await isKnownTelegramChat("acc-1", BigInt("999"))).toBe(false);
  });
});
