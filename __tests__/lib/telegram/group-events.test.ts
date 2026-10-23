import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks ───────────────────────────────────────────────────────────────────

const {
  mockFindUnique,
  mockUpdate,
  mockUpsert,
  mockDefinitionUpdateMany,
  mockRunUpdateMany,
  mockTransaction,
  mockGetTelegramChatInfo,
  mockLeaveTelegramChat,
  mockSendTelegramMessage,
  mockGetLinkByTelegramUserId,
} = vi.hoisted(() => ({
  mockFindUnique: vi.fn(),
  mockUpdate: vi.fn(),
  mockUpsert: vi.fn(),
  mockDefinitionUpdateMany: vi.fn(),
  mockRunUpdateMany: vi.fn(),
  mockTransaction: vi.fn(),
  mockGetTelegramChatInfo: vi.fn(),
  mockLeaveTelegramChat: vi.fn(),
  mockSendTelegramMessage: vi.fn(),
  mockGetLinkByTelegramUserId: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    telegramChat: {
      findUnique: (...args: unknown[]) => mockFindUnique(...args),
      update: (...args: unknown[]) => mockUpdate(...args),
      upsert: (...args: unknown[]) => mockUpsert(...args),
    },
    agentDefinition: { updateMany: (...args: unknown[]) => mockDefinitionUpdateMany(...args) },
    agentRun: { updateMany: (...args: unknown[]) => mockRunUpdateMany(...args) },
    $transaction: (...args: unknown[]) => mockTransaction(...args),
  },
}));

vi.mock("@/lib/telegram/bot", () => ({ TELEGRAM_BOT_ID: "global" }));

vi.mock("@/lib/telegram/links", () => ({
  getLinkByTelegramUserId: (...args: unknown[]) => mockGetLinkByTelegramUserId(...args),
}));

// Keep the real message builders: their text is what the group reads.
vi.mock("@/lib/telegram/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/telegram/client")>();
  return {
    ...actual,
    getTelegramChatInfo: (...args: unknown[]) => mockGetTelegramChatInfo(...args),
    leaveTelegramChat: (...args: unknown[]) => mockLeaveTelegramChat(...args),
    sendTelegramMessage: (...args: unknown[]) => mockSendTelegramMessage(...args),
  };
});

const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

import { handleGroupServiceMessage, type GroupServiceMessage } from "@/lib/telegram/group-events";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const BOT_ID = BigInt(777);
const GROUP_ID = -1001234567890;
const ADDER_ID = 7256145893;

const link = {
  id: "link-1",
  userId: "user-1",
  telegramUserId: BigInt(ADDER_ID),
  telegramChatId: BigInt(ADDER_ID),
  displayName: "Jane",
  sessionId: null,
  activeSessionId: null,
  createdAt: new Date("2026-02-01T00:00:00.000Z"),
  updatedAt: new Date("2026-02-01T00:00:00.000Z"),
};

function chatRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "chat-row-1",
    botId: "global",
    ownerUserId: "user-1",
    chatId: BigInt(GROUP_ID),
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

function message(overrides: Partial<GroupServiceMessage> = {}): GroupServiceMessage {
  return {
    chat: { id: GROUP_ID, type: "supergroup", title: "CVEs" },
    from: { id: ADDER_ID, first_name: "Jane" },
    message_id: 1,
    ...overrides,
  };
}

const addedTheBot = { new_chat_members: [{ id: Number(BOT_ID), is_bot: true }] };

function handle(overrides: Partial<GroupServiceMessage> = {}) {
  return handleGroupServiceMessage({
    message: message(overrides),
    botId: BOT_ID,
    encryptedToken: "enc",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetLinkByTelegramUserId.mockResolvedValue(link);
  mockFindUnique.mockResolvedValue(null);
  mockUpdate.mockResolvedValue(chatRow());
  mockUpsert.mockResolvedValue(chatRow());
  mockDefinitionUpdateMany.mockResolvedValue({ count: 0 });
  mockRunUpdateMany.mockResolvedValue({ count: 0 });
  mockTransaction.mockImplementation(async (ops: unknown[]) => Promise.all(ops));
  mockGetTelegramChatInfo.mockResolvedValue({
    chatId: BigInt(GROUP_ID),
    title: "CVEs",
    kind: "supergroup",
    memberCount: 42,
  });
  mockLeaveTelegramChat.mockResolvedValue(undefined);
  mockSendTelegramMessage.mockResolvedValue([10]);
});

// ─── Adding the bot ─────────────────────────────────────────────────────────

describe("a linked user adds the bot", () => {
  it("registers the group and confirms it in their private chat", async () => {
    await handle(addedTheBot);

    expect(mockUpsert).toHaveBeenCalledWith({
      where: { chatId: BigInt(GROUP_ID) },
      create: {
        botId: "global",
        ownerUserId: "user-1",
        chatId: BigInt(GROUP_ID),
        title: "CVEs",
        kind: "supergroup",
        memberCount: 42,
        syncedAt: expect.any(Date),
      },
      update: {},
    });
    // The confirmation goes to the private chat, never into the group.
    expect(mockSendTelegramMessage).toHaveBeenCalledWith(
      "enc",
      link.telegramChatId,
      expect.stringContaining("CVEs"),
      { parseMode: "HTML" },
    );
    expect(mockLeaveTelegramChat).not.toHaveBeenCalled();
  });

  it("registers the group even when getChat refuses, using the message's title", async () => {
    mockGetTelegramChatInfo.mockRejectedValue(new Error("chat not found"));

    await handle(addedTheBot);

    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ title: "CVEs", kind: "supergroup", syncedAt: null }),
      }),
    );
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining("while registering it"),
      expect.any(Error),
    );
  });

  it("escapes the group title in the confirmation", async () => {
    mockGetTelegramChatInfo.mockResolvedValue({
      chatId: BigInt(GROUP_ID),
      title: "<b>Not markup</b>",
      kind: "supergroup",
      memberCount: 42,
    });

    await handle(addedTheBot);

    const sent = mockSendTelegramMessage.mock.calls[0]![2] as string;
    expect(sent).toContain("&lt;b&gt;Not markup&lt;/b&gt;");
  });

  it("re-enables its own disabled group without touching the owner", async () => {
    mockFindUnique.mockResolvedValue(chatRow({ enabled: false }));

    await handle(addedTheBot);

    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: "chat-row-1" },
      data: expect.objectContaining({ enabled: true, title: "CVEs" }),
    });
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("ignores a member who is not the bot", async () => {
    await handle({ new_chat_members: [{ id: 999, is_bot: false }] });

    expect(mockGetLinkByTelegramUserId).not.toHaveBeenCalled();
    expect(mockUpsert).not.toHaveBeenCalled();
  });
});

describe("an add the bot refuses", () => {
  it("refuses and leaves when the adder has no Saale account", async () => {
    mockGetLinkByTelegramUserId.mockResolvedValue(null);

    await handle(addedTheBot);

    expect(mockUpsert).not.toHaveBeenCalled();
    expect(mockSendTelegramMessage).toHaveBeenCalledWith(
      "enc",
      BigInt(GROUP_ID),
      expect.stringContaining("Integrations → Telegram"),
      { parseMode: "HTML" },
    );
    expect(mockLeaveTelegramChat).toHaveBeenCalledWith("enc", BigInt(GROUP_ID));
  });

  it("says nothing about who owns the group", async () => {
    mockFindUnique.mockResolvedValue(chatRow({ ownerUserId: "user-2" }));

    await handle(addedTheBot);

    const refusal = mockSendTelegramMessage.mock.calls[0]![2] as string;
    expect(refusal).not.toContain("user-2");
    expect(refusal).not.toContain("owner");
    expect(mockLeaveTelegramChat).toHaveBeenCalled();
  });

  it("refuses and leaves when nobody can be held to the add", async () => {
    await handle({ ...addedTheBot, from: undefined });

    expect(mockGetLinkByTelegramUserId).not.toHaveBeenCalled();
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(mockLeaveTelegramChat).toHaveBeenCalledWith("enc", BigInt(GROUP_ID));
  });

  it("never reassigns a group another user already owns", async () => {
    mockFindUnique.mockResolvedValue(chatRow({ ownerUserId: "user-2" }));

    await handle(addedTheBot);

    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(mockLeaveTelegramChat).toHaveBeenCalledWith("enc", BigInt(GROUP_ID));
  });

  it("still leaves when the refusal cannot be sent", async () => {
    mockGetLinkByTelegramUserId.mockResolvedValue(null);
    mockSendTelegramMessage.mockRejectedValue(new Error("blocked"));

    await handle(addedTheBot);

    expect(mockLeaveTelegramChat).toHaveBeenCalledWith("enc", BigInt(GROUP_ID));
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("group refusal"),
      expect.any(Error),
    );
  });
});

// ─── Service messages from a known group ────────────────────────────────────

describe("service messages from a registered group", () => {
  beforeEach(() => {
    mockFindUnique.mockResolvedValue(chatRow());
  });

  it("ignores anything a member typed", async () => {
    await handle({ text: "hello everyone" } as Partial<GroupServiceMessage>);

    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockSendTelegramMessage).not.toHaveBeenCalled();
  });

  it("ignores a group the bot is not registered in", async () => {
    mockFindUnique.mockResolvedValue(null);

    await handle({ new_chat_title: "Renamed" });

    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("follows a renamed group", async () => {
    await handle({ new_chat_title: "Renamed" });

    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: "chat-row-1" },
      data: { title: "Renamed", syncedAt: expect.any(Date) },
    });
  });

  it("marks the group disabled when the bot is removed", async () => {
    await handle({ left_chat_member: { id: Number(BOT_ID), is_bot: true } });

    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: "chat-row-1" },
      data: { enabled: false },
    });
  });

  it("ignores another member leaving", async () => {
    await handle({ left_chat_member: { id: 12345, is_bot: false } });

    expect(mockUpdate).not.toHaveBeenCalled();
  });
});

// ─── Migration to a supergroup ──────────────────────────────────────────────

describe("a group upgraded to a supergroup", () => {
  const NEW_ID = -1009876543210;

  it("rewrites the row and the stored send targets", async () => {
    mockFindUnique.mockResolvedValue(chatRow());

    await handle({ migrate_to_chat_id: NEW_ID });

    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: "chat-row-1" },
      data: { chatId: BigInt(NEW_ID), syncedAt: null },
    });
    expect(mockDefinitionUpdateMany).toHaveBeenCalledWith({
      where: { userId: "user-1", outputChannelId: String(GROUP_ID) },
      data: { outputChannelId: String(NEW_ID) },
    });
    expect(mockRunUpdateMany).toHaveBeenCalledWith({
      where: { userId: "user-1", outputChannelId: String(GROUP_ID) },
      data: { outputChannelId: String(NEW_ID) },
    });
  });

  it("handles the same migration seen from the new chat", async () => {
    mockFindUnique.mockImplementation(async ({ where }: { where: { chatId: bigint } }) =>
      where.chatId === BigInt(GROUP_ID) ? chatRow() : null,
    );

    await handleGroupServiceMessage({
      message: message({
        chat: { id: NEW_ID, type: "supergroup", title: "CVEs" },
        migrate_from_chat_id: GROUP_ID,
      }),
      botId: BOT_ID,
      encryptedToken: "enc",
    });

    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: "chat-row-1" },
      data: { chatId: BigInt(NEW_ID), syncedAt: null },
    });
  });

  it("does nothing for a group it does not know", async () => {
    mockFindUnique.mockResolvedValue(null);

    await handle({ migrate_to_chat_id: NEW_ID });

    expect(mockTransaction).not.toHaveBeenCalled();
  });
});
