import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks ───────────────────────────────────────────────────────────────────

const mockSendTelegramToUser = vi.fn();

vi.mock("@/lib/telegram/notify", () => ({
  sendTelegramToUser: (...args: unknown[]) => mockSendTelegramToUser(...args),
}));

import { createTelegramTools } from "@/lib/pi/tools/telegram-tools";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const userId = "user-1";

/** The single tool this factory exposes. */
function telegramTool(): ToolDefinition {
  const tools = createTelegramTools(userId);
  expect(tools).toHaveLength(1);
  return tools[0]!;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const callExecute = (execute: any, params: Record<string, unknown>) =>
  execute("call-1", params, undefined, undefined, {} as never);

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("createTelegramTools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends the message to the user's own chat and reports delivery", async () => {
    mockSendTelegramToUser.mockResolvedValue({
      ok: true,
      chatId: "119075844",
      label: "Jane",
    });

    const result = await callExecute(telegramTool().execute, {
      message: "Dentist at 14:30",
    });

    expect(mockSendTelegramToUser).toHaveBeenCalledWith({
      userId,
      content: "Dentist at 14:30",
    });
    expect(result.content[0].text).toContain("Jane");
    expect(result.details).toEqual({ chatId: "119075844", label: "Jane" });
  });

  it("never accepts a recipient  the tool has no chat parameter", () => {
    const tool = telegramTool();
    const parameters = tool.parameters as { properties?: Record<string, unknown> };

    expect(Object.keys(parameters.properties ?? {})).toEqual(["message"]);
  });

  it("throws with the reason when nothing was delivered", async () => {
    mockSendTelegramToUser.mockResolvedValue({
      ok: false,
      reason: "not_configured",
      error: "No Telegram bot is connected.",
    });

    // A returned error result would reach the model as a successful call, so the
    // tool must throw  the agent loop flags it and keeps the reason.
    await expect(callExecute(telegramTool().execute, { message: "hi" })).rejects.toThrow(
      /No Telegram bot is connected/,
    );
  });

  it("refuses an empty message without calling Telegram", async () => {
    await expect(callExecute(telegramTool().execute, { message: "   " })).rejects.toThrow(
      /message is empty/,
    );

    expect(mockSendTelegramToUser).not.toHaveBeenCalled();
  });

  it("trims the message before sending", async () => {
    mockSendTelegramToUser.mockResolvedValue({ ok: true, chatId: "1", label: "Jane" });

    await callExecute(telegramTool().execute, { message: "  Standup in 5  " });

    expect(mockSendTelegramToUser).toHaveBeenCalledWith({
      userId,
      content: "Standup in 5",
    });
  });

  it("binds the user from the factory closure, not from the call", async () => {
    mockSendTelegramToUser.mockResolvedValue({ ok: true, chatId: "1", label: "Jane" });

    const otherTool = createTelegramTools("user-2")[0]!;
    await callExecute(otherTool.execute, { message: "hello" });

    expect(mockSendTelegramToUser).toHaveBeenCalledWith({
      userId: "user-2",
      content: "hello",
    });
  });
});
