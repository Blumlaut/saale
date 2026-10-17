import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ─── Mocks ───────────────────────────────────────────────────────────────────

const {
  fakeBot,
  mockGetTelegramBot,
  mockConsumeLinkCode,
  mockGetLinkByTelegramUserId,
  mockUpdateLinkDisplayName,
  mockProcessTelegramMessage,
  mockHandleApprovalCallback,
  mockHandleCommandPromptCallback,
  mockHandleTelegramCommand,
  mockInterruptTelegramChat,
  mockNextMessageSeq,
} = vi.hoisted(() => ({
  fakeBot: {
    api: {
      sendMessage: vi.fn(),
      answerCallbackQuery: vi.fn(),
    },
  },
  mockGetTelegramBot: vi.fn(),
  mockConsumeLinkCode: vi.fn(),
  mockGetLinkByTelegramUserId: vi.fn(),
  mockUpdateLinkDisplayName: vi.fn(),
  mockProcessTelegramMessage: vi.fn(),
  mockHandleApprovalCallback: vi.fn(),
  mockHandleCommandPromptCallback: vi.fn(),
  mockHandleTelegramCommand: vi.fn(),
  mockInterruptTelegramChat: vi.fn(),
  mockNextMessageSeq: vi.fn(),
}));

// Keep the real message builders (their text is what the user reads) and stub
// only the network client.
vi.mock("@/lib/telegram/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/telegram/client")>();
  return { ...actual, createBot: () => fakeBot };
});

vi.mock("@/lib/telegram/bot", () => ({
  getTelegramBot: (...args: unknown[]) => mockGetTelegramBot(...args),
}));

vi.mock("@/lib/telegram/links", () => ({
  // Real pattern — the payload-shape gate is part of what's under test.
  LINK_CODE_PATTERN: /^[A-Za-z0-9_-]{32}$/,
  consumeLinkCode: (...args: unknown[]) => mockConsumeLinkCode(...args),
  getLinkByTelegramUserId: (...args: unknown[]) => mockGetLinkByTelegramUserId(...args),
  updateLinkDisplayName: (...args: unknown[]) => mockUpdateLinkDisplayName(...args),
}));

vi.mock("@/lib/telegram/processor", () => ({
  processTelegramMessage: (...args: unknown[]) => mockProcessTelegramMessage(...args),
}));

vi.mock("@/lib/telegram/approval", () => ({
  handleApprovalCallback: (...args: unknown[]) => mockHandleApprovalCallback(...args),
}));

vi.mock("@/lib/telegram/command-prompts", () => ({
  handleCommandPromptCallback: (...args: unknown[]) => mockHandleCommandPromptCallback(...args),
  handleTelegramCommand: (...args: unknown[]) => mockHandleTelegramCommand(...args),
}));

vi.mock("@/lib/telegram/session-registry", () => ({
  attachTelegramSession: vi.fn(),
  interruptTelegramChat: (...args: unknown[]) => mockInterruptTelegramChat(...args),
  nextMessageSeq: (...args: unknown[]) => mockNextMessageSeq(...args),
}));

const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

import { POST } from "@/app/api/integrations/telegram/webhook/route";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const SECRET = "webhook-secret";
// A realistic Telegram ID: large enough to be meaningful, small enough that it
// survives JSON round-tripping (Telegram sends IDs as JSON numbers).
const SENDER_ID = 7256145893;
const CHAT_ID = 7256145893;

const botConfig = {
  id: "global",
  encryptedToken: "enc",
  enabled: true,
  botId: BigInt(1),
  botUsername: "saale_bot",
  webhookSecret: SECRET,
  updatedByUserId: "admin-1",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};

const link = {
  id: "link-1",
  userId: "user-1",
  telegramUserId: BigInt(SENDER_ID),
  telegramChatId: BigInt(CHAT_ID),
  displayName: "Jane",
  sessionId: "session-1",
  createdAt: new Date("2026-02-01T00:00:00.000Z"),
  updatedAt: new Date("2026-02-01T00:00:00.000Z"),
};

/** A valid one-time code: 32 base64url characters, the shape the bot accepts. */
const CODE = "abcDEF123_-GHIJKL456_-mnopqr789_";

function update(body: Record<string, unknown>, secret: string | null = SECRET) {
  return new NextRequest("http://localhost/api/integrations/telegram/webhook", {
    method: "POST",
    headers: secret
      ? { "content-type": "application/json", "x-telegram-bot-api-secret-token": secret }
      : { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function messageUpdate(overrides: Record<string, unknown> = {}) {
  return {
    message: {
      text: "hello",
      chat: { id: CHAT_ID, type: "private" },
      from: { id: SENDER_ID, first_name: "Jane", last_name: "Doe" },
      message_id: 5,
      ...overrides,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetTelegramBot.mockResolvedValue(botConfig);
  mockGetLinkByTelegramUserId.mockResolvedValue(link);
  mockUpdateLinkDisplayName.mockResolvedValue(undefined);
  mockProcessTelegramMessage.mockResolvedValue(undefined);
  mockNextMessageSeq.mockReturnValue(1);
  mockInterruptTelegramChat.mockResolvedValue(undefined);
  mockHandleTelegramCommand.mockResolvedValue(undefined);
  mockHandleApprovalCallback.mockResolvedValue({ handled: false });
  mockHandleCommandPromptCallback.mockResolvedValue({ handled: false });
  mockHandleCommandPromptCallback.mockResolvedValue({ handled: false });
  fakeBot.api.sendMessage.mockResolvedValue({ message_id: 1 });
  fakeBot.api.answerCallbackQuery.mockResolvedValue(true);
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("webhook gating", () => {
  it("reports 404 when the instance has no bot", async () => {
    mockGetTelegramBot.mockResolvedValue(null);

    expect((await POST(update(messageUpdate()))).status).toBe(404);
    expect(mockProcessTelegramMessage).not.toHaveBeenCalled();
  });

  it("reports 403 when the bot is switched off", async () => {
    mockGetTelegramBot.mockResolvedValue({ ...botConfig, enabled: false });

    expect((await POST(update(messageUpdate()))).status).toBe(403);
    expect(mockProcessTelegramMessage).not.toHaveBeenCalled();
  });

  it("rejects a delivery without the secret header", async () => {
    expect((await POST(update(messageUpdate(), null))).status).toBe(403);
    expect(mockProcessTelegramMessage).not.toHaveBeenCalled();
  });

  it("rejects a delivery signed with the wrong secret", async () => {
    expect((await POST(update(messageUpdate(), "wrong"))).status).toBe(403);
    expect(mockProcessTelegramMessage).not.toHaveBeenCalled();
  });

  it("rejects a body that is not JSON", async () => {
    const request = new NextRequest("http://localhost/api/integrations/telegram/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": SECRET },
      body: "not json",
    });

    expect((await POST(request)).status).toBe(400);
  });
});

describe("linking through the bot", () => {
  beforeEach(() => {
    mockGetLinkByTelegramUserId.mockResolvedValue(null);
  });

  it("uses a fixture code of the shape the bot accepts", () => {
    expect(CODE).toHaveLength(32);
    expect(CODE).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });

  it("tells an unlinked sender where to link — and processes nothing", async () => {
    const response = await POST(update(messageUpdate()));

    expect(response.status).toBe(200);
    expect(fakeBot.api.sendMessage).toHaveBeenCalledWith(
      CHAT_ID,
      expect.stringContaining("Settings"),
      expect.objectContaining({ parse_mode: "HTML" }),
    );
    expect(mockProcessTelegramMessage).not.toHaveBeenCalled();
    expect(mockHandleTelegramCommand).not.toHaveBeenCalled();
  });

  it("on a bare /start, explains how to link", async () => {
    await POST(update(messageUpdate({ text: "/start" })));

    expect(fakeBot.api.sendMessage).toHaveBeenCalledWith(
      CHAT_ID,
      expect.stringContaining("link your account"),
      expect.anything(),
    );
    expect(mockConsumeLinkCode).not.toHaveBeenCalled();
  });

  it("redeems a /start payload bound to the sender's Telegram identity", async () => {
    mockConsumeLinkCode.mockResolvedValue({ ok: true, link });

    await POST(update(messageUpdate({ text: `/start ${CODE}` })));

    expect(mockConsumeLinkCode).toHaveBeenCalledWith({
      code: CODE,
      telegramUserId: BigInt(SENDER_ID),
      telegramChatId: BigInt(CHAT_ID),
      displayName: "Jane Doe",
    });
    expect(fakeBot.api.sendMessage).toHaveBeenCalledWith(
      CHAT_ID,
      expect.stringContaining("Linked"),
      expect.anything(),
    );
  });

  it("redeems a bare code sent on its own, no /start prefix", async () => {
    mockConsumeLinkCode.mockResolvedValue({ ok: true, link });

    // Telegram auto-sends /start when the chat opens, so the user naturally
    // sends just the token — that has to work too.
    await POST(update(messageUpdate({ text: CODE })));

    expect(mockConsumeLinkCode).toHaveBeenCalledWith({
      code: CODE,
      telegramUserId: BigInt(SENDER_ID),
      telegramChatId: BigInt(CHAT_ID),
      displayName: "Jane Doe",
    });
    expect(fakeBot.api.sendMessage).toHaveBeenCalledWith(
      CHAT_ID,
      expect.stringContaining("Linked"),
      expect.anything(),
    );
    expect(mockProcessTelegramMessage).not.toHaveBeenCalled();
  });

  it("treats a bare code with surrounding whitespace as the code", async () => {
    mockConsumeLinkCode.mockResolvedValue({ ok: true, link });

    await POST(update(messageUpdate({ text: `  ${CODE}\n` })));

    expect(mockConsumeLinkCode).toHaveBeenCalledWith(expect.objectContaining({ code: CODE }));
  });

  it("does not intercept a code-shaped string that is not a code", async () => {
    // One character short of a code — a linked user's message stays a message.
    mockGetLinkByTelegramUserId.mockResolvedValue(link);
    await POST(update(messageUpdate({ text: CODE.slice(0, 31) })));

    expect(mockConsumeLinkCode).not.toHaveBeenCalled();
    expect(mockProcessTelegramMessage).toHaveBeenCalledWith(
      expect.objectContaining({ messageText: CODE.slice(0, 31) }),
    );
  });

  it("accepts /link as an alias for the deep-link payload", async () => {
    mockConsumeLinkCode.mockResolvedValue({ ok: true, link });

    await POST(update(messageUpdate({ text: `/link ${CODE}` })));

    expect(mockConsumeLinkCode).toHaveBeenCalledWith(expect.objectContaining({ code: CODE }));
  });

  it("does not look up a code that cannot be one", async () => {
    await POST(update(messageUpdate({ text: "/start hi" })));

    // A short payload never reaches the database — only a real code shape does.
    expect(mockConsumeLinkCode).not.toHaveBeenCalled();
    expect(fakeBot.api.sendMessage).toHaveBeenCalledWith(
      CHAT_ID,
      expect.stringContaining("invalid or has expired"),
      expect.anything(),
    );
  });

  it("refuses a code whose Telegram account is already linked elsewhere", async () => {
    mockConsumeLinkCode.mockResolvedValue({ ok: false, reason: "already_linked" });

    await POST(update(messageUpdate({ text: `/start ${CODE}` })));

    expect(fakeBot.api.sendMessage).toHaveBeenCalledWith(
      CHAT_ID,
      expect.stringContaining("already linked to a different Saale account"),
      expect.anything(),
    );
  });

  it("reports an expired code", async () => {
    mockConsumeLinkCode.mockResolvedValue({ ok: false, reason: "expired" });

    await POST(update(messageUpdate({ text: `/start ${CODE}` })));

    expect(fakeBot.api.sendMessage).toHaveBeenCalledWith(
      CHAT_ID,
      expect.stringContaining("invalid or has expired"),
      expect.anything(),
    );
  });

  it("re-links an already-linked sender instead of refusing", async () => {
    // Redeeming a fresh code is how someone switches which Telegram account
    // they talk from, so it must work while linked.
    mockGetLinkByTelegramUserId.mockResolvedValue(null);
    mockConsumeLinkCode.mockResolvedValue({ ok: true, link });

    await POST(update(messageUpdate({ text: `/start ${CODE}` })));

    expect(mockConsumeLinkCode).toHaveBeenCalled();
  });
});

describe("message routing", () => {
  it("runs the message as the account the sender is linked to", async () => {
    await POST(update(messageUpdate()));

    expect(mockProcessTelegramMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        // Resolved from the link alone — nothing in the message names a user.
        userId: "user-1",
        telegramUserId: BigInt(SENDER_ID),
        telegramChatId: BigInt(CHAT_ID),
        messageText: "hello",
      }),
    );
  });

  it("caches the sender's display name on the link", async () => {
    await POST(update(messageUpdate()));

    expect(mockUpdateLinkDisplayName).toHaveBeenCalledWith(BigInt(SENDER_ID), "Jane Doe");
  });

  it("ignores group chats", async () => {
    const response = await POST(update(messageUpdate({ chat: { id: -100123, type: "group" } })));

    expect(response.status).toBe(200);
    expect(mockProcessTelegramMessage).not.toHaveBeenCalled();
    expect(mockGetLinkByTelegramUserId).not.toHaveBeenCalled();
  });

  it("ignores a message with nothing to process", async () => {
    await POST(update(messageUpdate({ text: undefined, voice: {} })));

    expect(mockProcessTelegramMessage).not.toHaveBeenCalled();
  });

  it("supersedes an in-flight run before starting the new one", async () => {
    await POST(update(messageUpdate()));

    expect(mockInterruptTelegramChat).toHaveBeenCalledWith("user-1", BigInt(CHAT_ID));
    expect(mockNextMessageSeq).toHaveBeenCalledWith("user-1", BigInt(CHAT_ID));
  });

  it("dispatches a registry command instead of the agent, as the linked user", async () => {
    await POST(update(messageUpdate({ text: "/stop" })));

    expect(mockHandleTelegramCommand).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1", name: "stop" }),
    );
    expect(mockProcessTelegramMessage).not.toHaveBeenCalled();
  });

  it("sends an unknown slash command to the agent rather than swallowing it", async () => {
    await POST(update(messageUpdate({ text: "/dashboard/chat" })));

    expect(mockHandleTelegramCommand).not.toHaveBeenCalled();
    expect(mockProcessTelegramMessage).toHaveBeenCalledWith(
      expect.objectContaining({ messageText: "/dashboard/chat" }),
    );
  });
});

describe("inline button presses", () => {
  const callback = (overrides: Record<string, unknown> = {}) => ({
    callback_query: {
      id: "cb-1",
      data: "a:0123456789abcdef",
      from: { id: SENDER_ID, first_name: "Jane" },
      message: { chat: { id: CHAT_ID, type: "private" }, message_id: 7 },
      ...overrides,
    },
  });

  it("hands the press to the approval handler with the presser's identity", async () => {
    mockHandleApprovalCallback.mockResolvedValue({
      handled: true,
      message: "✅ Tool call approved.",
    });

    await POST(update(callback()));

    // The presser id comes from Telegram's own payload — a forwarded card keeps
    // its buttons, so the decision must be attributable to whoever pressed it.
    expect(mockHandleApprovalCallback).toHaveBeenCalledWith(
      "a:0123456789abcdef",
      BigInt(SENDER_ID),
    );
    expect(fakeBot.api.answerCallbackQuery).toHaveBeenCalledWith("cb-1", {
      text: "✅ Tool call approved.",
      show_alert: false,
    });
    expect(mockHandleCommandPromptCallback).not.toHaveBeenCalled();
  });

  it("falls through to a command prompt when it is not an approval callback", async () => {
    mockHandleApprovalCallback.mockResolvedValue({ handled: false });
    mockHandleCommandPromptCallback.mockResolvedValue({ handled: true, message: "Model set." });

    await POST(update(callback({ data: "c:0123456789abcdef:s:0" })));

    expect(mockHandleCommandPromptCallback).toHaveBeenCalledWith(
      "c:0123456789abcdef:s:0",
      BigInt(SENDER_ID),
      { chat: { id: CHAT_ID, type: "private" }, message_id: 7 },
    );
    expect(fakeBot.api.answerCallbackQuery).toHaveBeenCalledWith("cb-1", {
      text: "Model set.",
      show_alert: false,
    });
  });

  it("never dispatches a press it cannot attribute to a sender", async () => {
    // Without `from`, whose decision this is cannot be established.
    await POST(update(callback({ from: undefined })));

    expect(mockHandleApprovalCallback).not.toHaveBeenCalled();
    expect(mockHandleCommandPromptCallback).not.toHaveBeenCalled();
    expect(fakeBot.api.answerCallbackQuery).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "Telegram callback query arrived without a sender — ignoring it",
    );
  });

  it("does not start a run for a callback query", async () => {
    await POST(update(callback()));

    expect(mockProcessTelegramMessage).not.toHaveBeenCalled();
  });
});
