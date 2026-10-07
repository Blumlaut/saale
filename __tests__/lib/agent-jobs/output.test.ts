import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks ───────────────────────────────────────────────────────────────────

const { mockTelegramAccount, mockSendTelegramMessage, mockSendTypingIndicator } = vi.hoisted(
  () => ({
    mockTelegramAccount: {
      findUnique: vi.fn(),
    },
    mockSendTelegramMessage: vi.fn(),
    mockSendTypingIndicator: vi.fn(),
  }),
);

vi.mock("@/lib/db", () => ({
  prisma: {
    telegramAccount: mockTelegramAccount,
  },
}));

vi.mock("@/lib/telegram/client", () => ({
  sendTelegramMessage: (...args: unknown[]) => mockSendTelegramMessage(...args),
  sendTypingIndicator: (...args: unknown[]) => mockSendTypingIndicator(...args),
}));

const mockResolveDefaultTelegramChat = vi.fn();
vi.mock("@/lib/telegram/chats", () => ({
  resolveDefaultTelegramChat: (...args: unknown[]) => mockResolveDefaultTelegramChat(...args),
}));

const mockRecordTelegramJobOutput = vi.fn();
vi.mock("@/lib/telegram/outbound", () => ({
  recordTelegramJobOutput: (...args: unknown[]) => mockRecordTelegramJobOutput(...args),
}));

const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

import { buildAgentOutputHandler } from "@/lib/agent-jobs/output";

/** An enabled account, as the resolver selects it. */
const enabledAccount = {
  id: "acc-1",
  encryptedToken: "enc-token",
  enabled: true,
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("buildAgentOutputHandler", () => {
  const userId = "user-123";

  beforeEach(() => {
    vi.clearAllMocks();
    mockRecordTelegramJobOutput.mockResolvedValue(undefined);
  });

  it("builds nothing, and reports nothing, when no output channel is set", async () => {
    const result = await buildAgentOutputHandler({
      userId,
      outputChannel: null,
      outputChannelId: null,
    });

    // No channel configured is not a failure — there was nothing to deliver.
    expect(result).toEqual({});
    expect(mockTelegramAccount.findUnique).not.toHaveBeenCalled();
  });

  it("inherits the configured chat when telegram has no explicit chat ID", async () => {
    mockTelegramAccount.findUnique.mockResolvedValue(enabledAccount);
    mockResolveDefaultTelegramChat.mockResolvedValue(BigInt("119075844"));
    mockSendTelegramMessage.mockResolvedValue([42]);

    const { output } = await buildAgentOutputHandler({
      userId,
      outputChannel: "telegram",
      outputChannelId: null,
    });

    expect(output).toBeDefined();
    expect(mockResolveDefaultTelegramChat).toHaveBeenCalledWith("acc-1");

    await output!.send("Job finished — here is the report");

    expect(mockSendTelegramMessage).toHaveBeenCalledWith(
      "enc-token",
      BigInt("119075844"),
      "Job finished — here is the report",
    );
  });

  it("reports an error when telegram inherits but no configured chat exists", async () => {
    mockTelegramAccount.findUnique.mockResolvedValue(enabledAccount);
    mockResolveDefaultTelegramChat.mockResolvedValue(null);

    const result = await buildAgentOutputHandler({
      userId,
      outputChannel: "telegram",
      outputChannelId: null,
    });

    // A configured channel that cannot resolve must not look like no channel:
    // the run would otherwise report success having told nobody.
    expect(result.output).toBeUndefined();
    expect(result.error).toContain("no chat is available");
  });

  it("reports an error for an unsupported channel with a target ID", async () => {
    const result = await buildAgentOutputHandler({
      userId,
      outputChannel: "discord",
      outputChannelId: "123456789",
    });

    expect(result.output).toBeUndefined();
    expect(result.error).toContain('Output channel "discord" is not supported');
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Output channel "discord" is not supported'),
    );
  });

  it("reports an error when telegram output is requested but no account is configured", async () => {
    mockTelegramAccount.findUnique.mockResolvedValue(null);

    const result = await buildAgentOutputHandler({
      userId,
      outputChannel: "telegram",
      outputChannelId: "119075844",
    });

    expect(result.output).toBeUndefined();
    expect(result.error).toContain("no Telegram bot is connected");
    expect(mockTelegramAccount.findUnique).toHaveBeenCalledWith({
      where: { userId },
      select: { id: true, encryptedToken: true, enabled: true },
    });
  });

  it("reports an error when the Telegram integration is disabled", async () => {
    mockTelegramAccount.findUnique.mockResolvedValue({ ...enabledAccount, enabled: false });

    const result = await buildAgentOutputHandler({
      userId,
      outputChannel: "telegram",
      outputChannelId: "119075844",
    });

    expect(result.output).toBeUndefined();
    expect(result.error).toContain("integration is disabled");
  });

  it("reports an error when the chat ID is not a valid bigint", async () => {
    mockTelegramAccount.findUnique.mockResolvedValue(enabledAccount);

    const result = await buildAgentOutputHandler({
      userId,
      outputChannel: "telegram",
      outputChannelId: "not-a-number",
    });

    expect(result.output).toBeUndefined();
    expect(result.error).toContain('invalid chat ID "not-a-number"');
  });

  it("delivers turn text to the configured chat and records it for replies", async () => {
    mockTelegramAccount.findUnique.mockResolvedValue(enabledAccount);
    mockSendTelegramMessage.mockResolvedValue([42]);

    const { output } = await buildAgentOutputHandler({
      userId,
      outputChannel: "telegram",
      outputChannelId: "119075844",
    });

    expect(output!.send).toBeTypeOf("function");
    await output!.send("Job finished — here is the report");

    expect(mockSendTelegramMessage).toHaveBeenCalledWith(
      "enc-token",
      BigInt("119075844"),
      "Job finished — here is the report",
    );

    // The outbound message is recorded so a reply to it has context.
    expect(mockRecordTelegramJobOutput).toHaveBeenCalledWith({
      userId,
      telegramChatId: BigInt("119075844"),
      content: "Job finished — here is the report",
    });
    expect(output!.deliveryErrors?.()).toEqual([]);
  });

  it("collects a rejected send instead of swallowing it", async () => {
    mockTelegramAccount.findUnique.mockResolvedValue(enabledAccount);
    mockSendTelegramMessage.mockRejectedValue(new Error("chat not found"));

    const { output } = await buildAgentOutputHandler({
      userId,
      outputChannel: "telegram",
      outputChannelId: "119075844",
    });

    await output!.send("hello");

    expect(output!.deliveryErrors?.()).toEqual(["chat not found"]);
  });

  it("collects every rejected send, in order", async () => {
    mockTelegramAccount.findUnique.mockResolvedValue(enabledAccount);
    mockSendTelegramMessage
      .mockRejectedValueOnce(new Error("first failure"))
      .mockRejectedValueOnce(new Error("second failure"));

    const { output } = await buildAgentOutputHandler({
      userId,
      outputChannel: "telegram",
      outputChannelId: "119075844",
    });

    await output!.send("one");
    await output!.send("two");

    expect(output!.deliveryErrors?.()).toEqual(["first failure", "second failure"]);
  });

  it("still delivers when recording the message for replies fails", async () => {
    mockTelegramAccount.findUnique.mockResolvedValue(enabledAccount);
    mockSendTelegramMessage.mockResolvedValue([42]);
    mockRecordTelegramJobOutput.mockRejectedValue(new Error("db down"));

    const { output } = await buildAgentOutputHandler({
      userId,
      outputChannel: "telegram",
      outputChannelId: "119075844",
    });

    await output!.send("hello");

    // The session write is bookkeeping — it must never hold back the message.
    expect(mockSendTelegramMessage).toHaveBeenCalled();
    expect(output!.deliveryErrors?.()).toEqual([]);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to record outbound message"),
      expect.any(Error),
    );
  });

  it("typing() sends a typing indicator", async () => {
    mockTelegramAccount.findUnique.mockResolvedValue(enabledAccount);

    const { output } = await buildAgentOutputHandler({
      userId,
      outputChannel: "telegram",
      outputChannelId: "-100119075844",
    });

    expect(output!.typing).toBeTypeOf("function");
    output!.typing?.();

    expect(mockSendTypingIndicator).toHaveBeenCalledWith("enc-token", BigInt("-100119075844"));
  });
});
