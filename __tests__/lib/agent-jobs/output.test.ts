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

const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

import { buildAgentOutputHandler } from "@/lib/agent-jobs/output";

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("buildAgentOutputHandler", () => {
  const userId = "user-123";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns undefined when no output channel is set", async () => {
    const handler = await buildAgentOutputHandler({
      userId,
      outputChannel: null,
      outputChannelId: null,
    });

    expect(handler).toBeUndefined();
    expect(mockTelegramAccount.findUnique).not.toHaveBeenCalled();
  });

  it("returns undefined when channel is set but ID is missing", async () => {
    const handler = await buildAgentOutputHandler({
      userId,
      outputChannel: "telegram",
      outputChannelId: null,
    });

    expect(handler).toBeUndefined();
    expect(mockTelegramAccount.findUnique).not.toHaveBeenCalled();
  });

  it("logs and returns undefined when telegram output requested but no account configured", async () => {
    mockTelegramAccount.findUnique.mockResolvedValue(null);

    const handler = await buildAgentOutputHandler({
      userId,
      outputChannel: "telegram",
      outputChannelId: "119075844",
    });

    expect(handler).toBeUndefined();
    expect(mockTelegramAccount.findUnique).toHaveBeenCalledWith({
      where: { userId },
      select: { encryptedToken: true },
    });
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("no Telegram account is configured"),
    );
  });

  it("logs and returns undefined when chat ID is not a valid bigint", async () => {
    mockTelegramAccount.findUnique.mockResolvedValue({ encryptedToken: "enc-token" });

    const handler = await buildAgentOutputHandler({
      userId,
      outputChannel: "telegram",
      outputChannelId: "not-a-number",
    });

    expect(handler).toBeUndefined();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Invalid Telegram chat ID "not-a-number"'),
    );
  });

  it("builds a handler that sends turn text to the configured chat", async () => {
    mockTelegramAccount.findUnique.mockResolvedValue({ encryptedToken: "enc-token" });
    mockSendTelegramMessage.mockResolvedValue([42]);

    const handler = await buildAgentOutputHandler({
      userId,
      outputChannel: "telegram",
      outputChannelId: "119075844",
    });

    expect(handler).toBeDefined();
    expect(handler!.send).toBeTypeOf("function");

    handler!.send("Job finished — here is the report");

    // Send is fire-and-forget; allow the promise chain to run
    await vi.waitFor(() => {
      expect(mockSendTelegramMessage).toHaveBeenCalledWith(
        "enc-token",
        BigInt("119075844"),
        "Job finished — here is the report",
      );
    });
  });

  it("send logs an error when the Telegram API call fails", async () => {
    mockTelegramAccount.findUnique.mockResolvedValue({ encryptedToken: "enc-token" });
    mockSendTelegramMessage.mockRejectedValue(new Error("chat not found"));

    const handler = await buildAgentOutputHandler({
      userId,
      outputChannel: "telegram",
      outputChannelId: "119075844",
    });
    expect(handler).toBeDefined();

    handler!.send("hello");

    await vi.waitFor(() => {
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Failed to send Telegram output"),
        expect.any(Error),
      );
    });
  });

  it("typing() sends a typing indicator", async () => {
    mockTelegramAccount.findUnique.mockResolvedValue({ encryptedToken: "enc-token" });

    const handler = await buildAgentOutputHandler({
      userId,
      outputChannel: "telegram",
      outputChannelId: "-100119075844",
    });

    expect(handler!.typing).toBeTypeOf("function");
    handler!.typing?.();

    expect(mockSendTypingIndicator).toHaveBeenCalledWith("enc-token", BigInt("-100119075844"));
  });

  it("logs a warning and returns undefined for unsupported channels", async () => {
    const handler = await buildAgentOutputHandler({
      userId,
      outputChannel: "discord",
      outputChannelId: "123456789",
    });

    expect(handler).toBeUndefined();
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Output channel "discord" is not supported'),
    );
  });
});
