import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks ───────────────────────────────────────────────────────────────────

const { mockSendTelegramToUser, mockGetLinkByUserId, mockListTelegramChats } = vi.hoisted(() => ({
  mockSendTelegramToUser: vi.fn(),
  mockGetLinkByUserId: vi.fn(),
  mockListTelegramChats: vi.fn(),
}));

vi.mock("@/lib/telegram/notify", () => ({
  sendTelegramToUser: (...args: unknown[]) => mockSendTelegramToUser(...args),
}));

vi.mock("@/lib/telegram/links", () => ({
  getLinkByUserId: (...args: unknown[]) => mockGetLinkByUserId(...args),
}));

vi.mock("@/lib/telegram/chats", () => ({
  listTelegramChats: (...args: unknown[]) => mockListTelegramChats(...args),
}));

import { createTelegramTools } from "@/lib/pi/tools/telegram-tools";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const userId = "user-1";
const sessionId = "sess-1";

function toolNamed(name: string): ToolDefinition {
  const tool = createTelegramTools(userId, sessionId).find((t) => t.name === name);
  expect(tool).toBeDefined();
  return tool!;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const callExecute = (execute: any, params: Record<string, unknown>) =>
  execute("call-1", params, undefined, undefined, {} as never);

/** A group row as `listTelegramChats` returns it. */
const groupRow = {
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
};

const link = {
  id: "link-1",
  userId,
  telegramUserId: BigInt("119075844"),
  telegramChatId: BigInt("119075844"),
  displayName: "Jane",
  sessionId: null,
  lastOutboundSessionId: null,
  createdAt: new Date("2026-02-01T00:00:00.000Z"),
  updatedAt: new Date("2026-02-01T00:00:00.000Z"),
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("createTelegramTools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetLinkByUserId.mockResolvedValue(link);
    mockListTelegramChats.mockResolvedValue([]);
  });

  it("exposes the send and list tools", () => {
    const names = createTelegramTools(userId, sessionId).map((t) => t.name);

    expect(names).toEqual(["telegram_send", "telegram_chats"]);
  });

  describe("telegram_send", () => {
    it("sends the message to the user's own chat and reports delivery", async () => {
      mockSendTelegramToUser.mockResolvedValue({
        ok: true,
        chatId: "119075844",
        label: "Jane",
      });

      const result = await callExecute(toolNamed("telegram_send").execute, {
        message: "Dentist at 14:30",
      });

      expect(mockSendTelegramToUser).toHaveBeenCalledWith({
        userId,
        content: "Dentist at 14:30",
        sourceSessionId: sessionId,
        target: null,
      });
      expect(result.content[0].text).toContain("Jane");
      expect(result.details).toEqual({ chatId: "119075844", label: "Jane" });
    });

    it("takes an optional group target and nothing else", () => {
      const parameters = toolNamed("telegram_send").parameters as {
        properties?: Record<string, unknown>;
      };

      // The recipient is a chat id from `telegram_chats`, never a Telegram
      // user id, so there is no way to name a person.
      expect(Object.keys(parameters.properties ?? {})).toEqual(["message", "target"]);
    });

    it("passes a group target through to delivery", async () => {
      mockSendTelegramToUser.mockResolvedValue({
        ok: true,
        chatId: "-1001234567890",
        label: "CVEs",
      });

      const result = await callExecute(toolNamed("telegram_send").execute, {
        message: "Two new CVEs today",
        target: "-1001234567890",
      });

      expect(mockSendTelegramToUser).toHaveBeenCalledWith({
        userId,
        content: "Two new CVEs today",
        sourceSessionId: sessionId,
        target: "-1001234567890",
      });
      expect(result.details).toEqual({ chatId: "-1001234567890", label: "CVEs" });
    });

    it("throws with the available groups when the target is unknown", async () => {
      mockSendTelegramToUser.mockResolvedValue({
        ok: false,
        reason: "unknown_target",
        error: 'Unknown Telegram target "-100999". Available groups: "CVEs" (-1001234567890).',
      });

      // The list has to reach the model, or it repeats the same bad id.
      await expect(
        callExecute(toolNamed("telegram_send").execute, {
          message: "hi",
          target: "-100999",
        }),
      ).rejects.toThrow(/Available groups: "CVEs"/);
    });

    it("throws with the reason when nothing was delivered", async () => {
      mockSendTelegramToUser.mockResolvedValue({
        ok: false,
        reason: "not_configured",
        error: "No Telegram bot is connected.",
      });

      // A returned error result would reach the model as a successful call, so
      // the tool must throw  the agent loop flags it and keeps the reason.
      await expect(
        callExecute(toolNamed("telegram_send").execute, { message: "hi" }),
      ).rejects.toThrow(/No Telegram bot is connected/);
    });

    it("refuses an empty message without calling Telegram", async () => {
      await expect(
        callExecute(toolNamed("telegram_send").execute, { message: "   " }),
      ).rejects.toThrow(/message is empty/);

      expect(mockSendTelegramToUser).not.toHaveBeenCalled();
    });

    it("trims the message before sending", async () => {
      mockSendTelegramToUser.mockResolvedValue({ ok: true, chatId: "1", label: "Jane" });

      await callExecute(toolNamed("telegram_send").execute, { message: "  Standup in 5  " });

      expect(mockSendTelegramToUser).toHaveBeenCalledWith({
        userId,
        content: "Standup in 5",
        sourceSessionId: sessionId,
        target: null,
      });
    });

    it("binds the user from the factory closure, not from the call", async () => {
      mockSendTelegramToUser.mockResolvedValue({ ok: true, chatId: "1", label: "Jane" });

      const otherTool = createTelegramTools("user-2", "sess-2").find(
        (t) => t.name === "telegram_send",
      )!;
      await callExecute(otherTool.execute, { message: "hello" });

      expect(mockSendTelegramToUser).toHaveBeenCalledWith({
        userId: "user-2",
        content: "hello",
        sourceSessionId: "sess-2",
        target: null,
      });
    });
  });

  describe("telegram_chats", () => {
    it("lists the private chat and the groups", async () => {
      mockListTelegramChats.mockResolvedValue([groupRow]);

      const result = await callExecute(toolNamed("telegram_chats").execute, {});

      expect(mockListTelegramChats).toHaveBeenCalledWith(userId);
      expect(result.structuredContent).toEqual({
        chats: [
          {
            chatId: "119075844",
            title: "Jane",
            kind: "private",
            memberCount: null,
            enabled: true,
            isPrivate: true,
          },
          {
            chatId: "-1001234567890",
            title: "CVEs",
            kind: "supergroup",
            memberCount: 42,
            enabled: true,
            isPrivate: false,
          },
        ],
      });
      // The text a script or a model reads carries the ids, since that is the
      // only way to name a target.
      expect(result.content[0].text).toContain("-1001234567890");
    });

    it("reports an account with no chats at all", async () => {
      mockGetLinkByUserId.mockResolvedValue(null);

      const result = await callExecute(toolNamed("telegram_chats").execute, {});

      expect(result.structuredContent).toEqual({ chats: [] });
      expect(result.content[0].text).toContain("no Telegram chats");
    });

    it("keeps a group the bot was removed from, marked disabled", async () => {
      mockListTelegramChats.mockResolvedValue([{ ...groupRow, enabled: false }]);

      const result = await callExecute(toolNamed("telegram_chats").execute, {});

      expect(result.structuredContent.chats[1].enabled).toBe(false);
    });
  });
});
