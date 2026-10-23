import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks ───────────────────────────────────────────────────────────────────

const {
  mockGetTelegramBot,
  mockGetLinkByUserId,
  mockSendTelegramMessage,
  mockSendTypingIndicator,
  mockResolveTelegramSendTarget,
  TelegramTargetError,
} = vi.hoisted(() => ({
  mockGetTelegramBot: vi.fn(),
  mockGetLinkByUserId: vi.fn(),
  mockSendTelegramMessage: vi.fn(),
  mockSendTypingIndicator: vi.fn(),
  mockResolveTelegramSendTarget: vi.fn(),
  TelegramTargetError: class TelegramTargetError extends Error {},
}));

vi.mock("@/lib/telegram/bot", () => ({
  getTelegramBot: (...args: unknown[]) => mockGetTelegramBot(...args),
}));

vi.mock("@/lib/telegram/links", () => ({
  getLinkByUserId: (...args: unknown[]) => mockGetLinkByUserId(...args),
}));

// The resolver has its own test (`chats.test.ts`). Here it only has to answer
// with the chat the definition names, which is what the handler wires up.
vi.mock("@/lib/telegram/chats", () => ({
  TelegramTargetError,
  resolveTelegramSendTarget: (...args: unknown[]) => mockResolveTelegramSendTarget(...args),
}));

vi.mock("@/lib/telegram/client", () => ({
  sendTelegramMessage: (...args: unknown[]) => mockSendTelegramMessage(...args),
  sendTypingIndicator: (...args: unknown[]) => mockSendTypingIndicator(...args),
}));

const mockRecordOutboundMessage = vi.fn();
vi.mock("@/lib/telegram/outbound", () => ({
  recordOutboundMessage: (...args: unknown[]) => mockRecordOutboundMessage(...args),
}));

const mockRecordOutboundMessages = vi.fn();
vi.mock("@/lib/telegram/outbound-messages", () => ({
  recordOutboundMessages: (...args: unknown[]) => mockRecordOutboundMessages(...args),
}));

const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

import { buildAgentOutputHandler } from "@/lib/agent-jobs/output";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const userId = "user-123";
const chatId = BigInt("119075844");

/** The configured bot, as `getTelegramBot` returns it. */
const bot = {
  id: "global",
  encryptedToken: "enc-token",
  enabled: true,
  botId: BigInt(1),
  botUsername: "saale_bot",
  webhookSecret: "secret",
  updatedByUserId: "admin-1",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};

/** The user's link, as `getLinkByUserId` returns it. */
const link = {
  id: "link-1",
  userId,
  telegramUserId: chatId,
  telegramChatId: chatId,
  displayName: "Jane",
  sessionId: "sess-1",
  createdAt: new Date("2026-02-01T00:00:00.000Z"),
  updatedAt: new Date("2026-02-01T00:00:00.000Z"),
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetTelegramBot.mockResolvedValue(bot);
  mockGetLinkByUserId.mockResolvedValue(link);
  mockRecordOutboundMessage.mockResolvedValue(undefined);
  mockRecordOutboundMessages.mockResolvedValue(undefined);
  mockSendTelegramMessage.mockResolvedValue([42]);
  mockResolveTelegramSendTarget.mockImplementation(
    async ({ target }: { target?: string | null }) => {
      if (target) {
        return { chatId: BigInt(target), label: "CVEs", group: true };
      }
      return { chatId, label: "Jane", group: false };
    },
  );
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("buildAgentOutputHandler", () => {
  it("builds nothing, and reports nothing, when no output channel is set", async () => {
    const result = await buildAgentOutputHandler({ userId, outputChannel: null });

    // No channel configured is not a failure  there was nothing to deliver.
    expect(result).toEqual({});
    expect(mockGetTelegramBot).not.toHaveBeenCalled();
  });

  it("reports an error for a channel that is not supported yet", async () => {
    const result = await buildAgentOutputHandler({ userId, outputChannel: "discord" });

    expect(result.output).toBeUndefined();
    expect(result.error).toContain('Output channel "discord" is not supported');
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Output channel "discord" is not supported'),
    );
  });

  it("reports an error when telegram output is configured but no bot exists", async () => {
    mockGetTelegramBot.mockResolvedValue(null);

    const result = await buildAgentOutputHandler({ userId, outputChannel: "telegram" });

    // A configured channel that cannot resolve must not look like no channel:
    // the run would otherwise report success having told nobody.
    expect(result.output).toBeUndefined();
    expect(result.error).toContain("no Telegram bot is set up on this instance");
    expect(mockGetLinkByUserId).not.toHaveBeenCalled();
  });

  it("reports an error when the bot is switched off", async () => {
    mockGetTelegramBot.mockResolvedValue({ ...bot, enabled: false });

    const result = await buildAgentOutputHandler({ userId, outputChannel: "telegram" });

    expect(result.output).toBeUndefined();
    expect(result.error).toContain("switched off");
  });

  it("reports an error when the account has no linked Telegram user", async () => {
    mockGetLinkByUserId.mockResolvedValue(null);

    const result = await buildAgentOutputHandler({ userId, outputChannel: "telegram" });

    expect(result.output).toBeUndefined();
    expect(result.error).toContain("no linked Telegram user");
    expect(mockGetLinkByUserId).toHaveBeenCalledWith(userId);
  });

  it("delivers turn text to the caller's linked chat and records it for replies", async () => {
    const { output } = await buildAgentOutputHandler({ userId, outputChannel: "telegram" });

    expect(output!.send).toBeTypeOf("function");
    await output!.send("Job finished  here is the report");

    expect(mockSendTelegramMessage).toHaveBeenCalledWith(
      "enc-token",
      chatId,
      "Job finished  here is the report",
    );

    // The outbound message is recorded so a reply to it has context.
    expect(mockRecordOutboundMessage).toHaveBeenCalledWith({
      userId,
      content: "Job finished  here is the report",
      sourceSessionId: undefined,
      sentTo: null,
    });
    expect(output!.deliveryErrors?.()).toEqual([]);
  });

  it("never targets a chat other than the caller's own link", async () => {
    // With no `outputChannelId` the target is the link, full stop.
    const { output } = await buildAgentOutputHandler({ userId, outputChannel: "telegram" });

    await output!.send("hello");

    expect(mockResolveTelegramSendTarget).toHaveBeenCalledWith({ userId, target: undefined });
    expect(mockSendTelegramMessage).toHaveBeenCalledTimes(1);
    expect(mockSendTelegramMessage.mock.calls[0]![1]).toBe(chatId);
  });

  it("posts into the group the definition names, with a breadcrumb", async () => {
    const groupId = BigInt("-1001234567890");

    const { output } = await buildAgentOutputHandler({
      userId,
      outputChannel: "telegram",
      outputChannelId: "-1001234567890",
    });
    await output!.send("Two new CVEs today");

    expect(mockResolveTelegramSendTarget).toHaveBeenCalledWith({
      userId,
      target: "-1001234567890",
    });
    expect(mockSendTelegramMessage).toHaveBeenCalledWith(
      "enc-token",
      groupId,
      "Two new CVEs today",
    );
    // The chat that produced it learns where the message went, not its text.
    expect(mockRecordOutboundMessage).toHaveBeenCalledWith({
      userId,
      content: "Two new CVEs today",
      sourceSessionId: undefined,
      sentTo: "CVEs",
    });
  });

  it("reports a group the caller does not own instead of posting into it", async () => {
    mockResolveTelegramSendTarget.mockRejectedValue(
      new TelegramTargetError('Unknown Telegram target "-100999". Available groups: "CVEs".'),
    );

    const result = await buildAgentOutputHandler({
      userId,
      outputChannel: "telegram",
      outputChannelId: "-100999",
    });

    expect(result.output).toBeUndefined();
    expect(result.error).toContain('Available groups: "CVEs"');
    expect(mockSendTelegramMessage).not.toHaveBeenCalled();
  });

  it("surfaces a send into a group the bot was kicked from", async () => {
    mockSendTelegramMessage.mockRejectedValue(
      new Error("Forbidden: bot was kicked from the group"),
    );

    const { output } = await buildAgentOutputHandler({
      userId,
      outputChannel: "telegram",
      outputChannelId: "-1001234567890",
    });
    await output!.send("hello");

    // A kicked bot must leave a delivery error, not a run that reads delivered.
    expect(output!.deliveryErrors?.()).toEqual(["Forbidden: bot was kicked from the group"]);
  });

  it("collects a rejected send instead of swallowing it", async () => {
    mockSendTelegramMessage.mockRejectedValue(new Error("chat not found"));

    const { output } = await buildAgentOutputHandler({ userId, outputChannel: "telegram" });
    await output!.send("hello");

    expect(output!.deliveryErrors?.()).toEqual(["chat not found"]);
  });

  it("collects every rejected send, in order", async () => {
    mockSendTelegramMessage
      .mockRejectedValueOnce(new Error("first failure"))
      .mockRejectedValueOnce(new Error("second failure"));

    const { output } = await buildAgentOutputHandler({ userId, outputChannel: "telegram" });
    await output!.send("one");
    await output!.send("two");

    expect(output!.deliveryErrors?.()).toEqual(["first failure", "second failure"]);
  });

  it("still delivers when recording the message for replies fails", async () => {
    mockRecordOutboundMessage.mockRejectedValue(new Error("db down"));

    const { output } = await buildAgentOutputHandler({ userId, outputChannel: "telegram" });
    await output!.send("hello");

    // The session write is bookkeeping  it must never hold back the message.
    expect(mockSendTelegramMessage).toHaveBeenCalled();
    expect(output!.deliveryErrors?.()).toEqual([]);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to record outbound message"),
      expect.any(Error),
    );
  });

  it("typing() sends a typing indicator to the linked chat", async () => {
    const { output } = await buildAgentOutputHandler({ userId, outputChannel: "telegram" });

    expect(output!.typing).toBeTypeOf("function");
    output!.typing?.();

    expect(mockSendTypingIndicator).toHaveBeenCalledWith("enc-token", chatId);
  });

  describe("when the agent reaches the user itself", () => {
    /** A successful `telegram_send` result, as the executor forwards it. */
    function telegramSend(toolChatId: string | undefined, isError = false) {
      return {
        name: "telegram_send",
        args: { message: "Stand up" },
        structured: { sent: true, ...(toolChatId ? { chatId: toolChatId } : {}) },
        isError,
      };
    }

    it("drops the run's closing text so the message lands once", async () => {
      const { output } = await buildAgentOutputHandler({ userId, outputChannel: "telegram" });

      // The agent sends the reminder itself, then closes with the same text.
      output!.noteToolCall?.(telegramSend("119075844"));
      await output!.send("Stand up");

      // The tool already delivered it  forwarding the closing text would
      // message the user twice.
      expect(mockSendTelegramMessage).not.toHaveBeenCalled();
      expect(output!.deliveryErrors?.()).toEqual([]);
    });

    it("treats a send that reported no chat as self-delivered", async () => {
      const { output } = await buildAgentOutputHandler({ userId, outputChannel: "telegram" });

      output!.noteToolCall?.(telegramSend(undefined));
      await output!.send("Stand up");

      // Absent evidence of a different target, assume the tool reached the
      // user  a duplicate message is worse than none.
      expect(mockSendTelegramMessage).not.toHaveBeenCalled();
    });

    it("is not silenced by a tool result naming some other chat", async () => {
      const { output } = await buildAgentOutputHandler({ userId, outputChannel: "telegram" });

      // A stale or foreign id must not be able to suppress the user's message.
      output!.noteToolCall?.(telegramSend("-100999"));
      await output!.send("Weekly report");

      expect(mockSendTelegramMessage).toHaveBeenCalledWith("enc-token", chatId, "Weekly report");
    });

    it("ignores a failed tool call", async () => {
      const { output } = await buildAgentOutputHandler({ userId, outputChannel: "telegram" });

      // Nothing reached the user, so the runner still owes them the message.
      output!.noteToolCall?.(telegramSend("119075844", true));
      await output!.send("Stand up");

      expect(mockSendTelegramMessage).toHaveBeenCalledWith("enc-token", chatId, "Stand up");
    });

    it("ignores other tools", async () => {
      const { output } = await buildAgentOutputHandler({ userId, outputChannel: "telegram" });

      output!.noteToolCall?.({
        name: "email_send",
        args: { body: "hi" },
        structured: { chatId: "119075844" },
        isError: false,
      });
      await output!.send("Done");

      expect(mockSendTelegramMessage).toHaveBeenCalledTimes(1);
    });

    it("suppresses every later turn, not just the one after the send", async () => {
      const { output } = await buildAgentOutputHandler({ userId, outputChannel: "telegram" });

      await output!.send("Checking your calendar");
      output!.noteToolCall?.(telegramSend("119075844"));
      await output!.send("Stand up");
      await output!.send("Anything else?");

      // Only the turn before the agent took over delivery was forwarded.
      expect(mockSendTelegramMessage).toHaveBeenCalledTimes(1);
      expect(mockSendTelegramMessage).toHaveBeenCalledWith(
        "enc-token",
        chatId,
        "Checking your calendar",
      );
    });
  });
});
