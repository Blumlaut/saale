import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

// ─── Mocks ───────────────────────────────────────────────────────────────────

const { mockSendTelegramMessage, mockResolveToolSummary, mockSendSharedFileToTelegram } =
  vi.hoisted(() => ({
    mockSendTelegramMessage: vi.fn(),
    mockResolveToolSummary: vi.fn(),
    mockSendSharedFileToTelegram: vi.fn(),
  }));

vi.mock("@/lib/telegram/client", () => ({
  sendTelegramMessage: (...args: unknown[]) => mockSendTelegramMessage(...args),
}));

vi.mock("@/lib/telegram/files", () => ({
  sharedFileFromToolCall: (toolName: string, args: unknown) =>
    toolName === "show_file" ? { filePath: (args as { filePath: string }).filePath } : null,
  sendSharedFileToTelegram: (...args: unknown[]) => mockSendSharedFileToTelegram(...args),
}));

vi.mock("@/lib/pi/tool-summary-resolver", () => ({
  resolveToolSummary: (...args: unknown[]) => mockResolveToolSummary(...args),
}));

const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

import { createTelegramRunRenderer } from "@/lib/telegram/render";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const chatId = BigInt("119075844");

function renderer() {
  return createTelegramRunRenderer({
    userId: "user-1",
    encryptedToken: "enc",
    telegramChatId: chatId,
    replyToMessageId: 9,
  });
}

/** A streamed assistant message carrying `text`. */
function textUpdate(text: string): AgentSessionEvent {
  return {
    type: "message_update",
    message: { role: "assistant", content: [{ type: "text", text }] },
  } as unknown as AgentSessionEvent;
}

/** The same, with a tool call appended (which is what triggers a flush). */
function textUpdateWithToolCall(text: string): AgentSessionEvent {
  return {
    type: "message_update",
    message: {
      role: "assistant",
      content: [
        { type: "text", text },
        { type: "toolCall", id: "call-1", name: "bash", arguments: {} },
      ],
    },
  } as unknown as AgentSessionEvent;
}

function turnEnd(text: string): AgentSessionEvent {
  return {
    type: "turn_end",
    message: { role: "assistant", content: [{ type: "text", text }] },
  } as unknown as AgentSessionEvent;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSendTelegramMessage.mockResolvedValue([1]);
  mockResolveToolSummary.mockResolvedValue("Running a command");
  mockSendSharedFileToTelegram.mockResolvedValue(undefined);
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("createTelegramRunRenderer", () => {
  it("sends a turn's text once, threaded under the user's message", async () => {
    const r = renderer();

    r.onEvent(textUpdate("Looking into it"));
    r.onEvent(turnEnd("Looking into it"));

    expect(mockSendTelegramMessage).toHaveBeenCalledTimes(1);
    expect(mockSendTelegramMessage).toHaveBeenCalledWith("enc", chatId, "Looking into it", {
      replyToMessageId: 9,
    });
  });

  it("flushes text before a tool call so it arrives before the approval card", async () => {
    const r = renderer();

    r.onEvent(textUpdateWithToolCall("I need to run something"));

    expect(mockSendTelegramMessage).toHaveBeenCalledWith("enc", chatId, "I need to run something", {
      replyToMessageId: 9,
    });
  });

  it("does not send the same turn twice after a flush", async () => {
    const r = renderer();

    r.onEvent(textUpdateWithToolCall("Checking"));
    r.onEvent(turnEnd("Checking"));

    expect(mockSendTelegramMessage).toHaveBeenCalledTimes(1);
  });

  it("threads only the first turn under the user's message", async () => {
    const r = renderer();

    r.onEvent(turnEnd("first"));
    r.onEvent(turnEnd("second"));

    expect(mockSendTelegramMessage.mock.calls[0]![3]).toEqual({ replyToMessageId: 9 });
    expect(mockSendTelegramMessage.mock.calls[1]![3]).toBeUndefined();
  });

  it("delivers a single-turn answer that never fired turn_end", async () => {
    const r = renderer();

    r.onEvent(textUpdate("Only answer"));

    await r.finish(false);

    expect(mockSendTelegramMessage).toHaveBeenCalledWith("enc", chatId, "Only answer", {
      replyToMessageId: 9,
    });
  });

  it("stays silent when the run was interrupted", async () => {
    const r = renderer();

    r.onEvent(textUpdate("Half an ans"));
    await r.finish(true);

    expect(mockSendTelegramMessage).not.toHaveBeenCalled();
  });

  it("summarises a tool call once", async () => {
    const r = renderer();
    const start = {
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "bash",
      args: { command: "ls" },
    } as unknown as AgentSessionEvent;

    r.onEvent(start);
    r.onEvent(start);
    await vi.waitFor(() => expect(mockSendTelegramMessage).toHaveBeenCalled());

    expect(mockResolveToolSummary).toHaveBeenCalledTimes(1);
    expect(mockSendTelegramMessage).toHaveBeenCalledWith(
      "enc",
      chatId,
      expect.stringContaining("Running a command"),
    );
  });

  it("sends a file the agent showed", async () => {
    const r = renderer();
    const args = { filePath: "/workspace/report.md" };

    r.onEvent({
      type: "tool_execution_start",
      toolCallId: "call-2",
      toolName: "show_file",
      args,
    } as unknown as AgentSessionEvent);
    r.onEvent({
      type: "tool_execution_end",
      toolCallId: "call-2",
      isError: false,
      result: {},
    } as unknown as AgentSessionEvent);

    expect(mockSendSharedFileToTelegram).toHaveBeenCalledWith(
      expect.objectContaining({ telegramChatId: chatId, filePath: "/workspace/report.md" }),
    );
  });

  it("skips a failed tool's file", async () => {
    const r = renderer();

    r.onEvent({
      type: "tool_execution_start",
      toolCallId: "call-3",
      toolName: "show_file",
      args: { filePath: "/workspace/missing.md" },
    } as unknown as AgentSessionEvent);
    r.onEvent({
      type: "tool_execution_end",
      toolCallId: "call-3",
      isError: true,
      result: {},
    } as unknown as AgentSessionEvent);

    expect(mockSendSharedFileToTelegram).not.toHaveBeenCalled();
  });

  it("reports compaction start and end", async () => {
    const r = renderer();

    r.onEvent({ type: "compaction_start" } as unknown as AgentSessionEvent);
    r.onEvent({
      type: "compaction_end",
      aborted: false,
      result: { tokensBefore: 12000, estimatedTokensAfter: 3000 },
    } as unknown as AgentSessionEvent);

    expect(mockSendTelegramMessage).toHaveBeenCalledWith(
      "enc",
      chatId,
      expect.stringContaining("Compacting"),
    );
    expect(mockSendTelegramMessage).toHaveBeenCalledWith(
      "enc",
      chatId,
      expect.stringContaining("12,000 tokens"),
    );
  });

  it("ignores run-control events", () => {
    const r = renderer();

    r.onEvent({ type: "agent_settled" } as unknown as AgentSessionEvent);
    r.onEvent({
      type: "agent_end",
      willRetry: false,
      messages: [],
    } as unknown as AgentSessionEvent);

    expect(mockSendTelegramMessage).not.toHaveBeenCalled();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });
});
