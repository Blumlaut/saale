import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A chat run started from Telegram sends its approval requests to the phone.
 *
 * The chat's pooled agent publishes them on the session bus for the browser.
 * this covers the bridge that turns the same events into Telegram cards and
 * deletes them again, whichever surface resolves them.
 */

const h = vi.hoisted(() => ({
  subscribeSessionEvents: vi.fn(),
  getEnabledTelegramBot: vi.fn(),
  getLinkByUserId: vi.fn(),
  createBot: vi.fn(),
  deleteMessage: vi.fn(),
  resolveApproval: vi.fn(),
  redis: { setex: vi.fn(), get: vi.fn(), del: vi.fn() },
}));

vi.mock("@/lib/pi/session-events", () => ({
  subscribeSessionEvents: (...args: unknown[]) => h.subscribeSessionEvents(...args),
}));

vi.mock("@/lib/telegram/bot", () => ({
  getEnabledTelegramBot: (...args: unknown[]) => h.getEnabledTelegramBot(...args),
}));

vi.mock("@/lib/telegram/links", () => ({
  getLinkByUserId: (...args: unknown[]) => h.getLinkByUserId(...args),
  getLinkByTelegramUserId: vi.fn(),
}));

vi.mock("@/lib/redis", () => ({
  getRedis: () => h.redis,
}));

vi.mock("@/lib/db", () => ({ prisma: { chatSession: { findUnique: vi.fn() } } }));

vi.mock("@/lib/pi/tool-approval-gate", () => ({
  resolveApproval: (...args: unknown[]) => h.resolveApproval(...args),
}));

vi.mock("@/lib/telegram/client", () => ({
  createBot: (...args: unknown[]) => h.createBot(...args),
}));

import { createTelegramApprovalChannel } from "@/lib/telegram/approval";

const USER = "user-1";
const SESSION = "sess-1";
const TOKEN = "enc-token";

const sendMessage = vi.fn();
let listener: ((evt: { event: string; data: unknown }) => void) | undefined;
const unsubscribe = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  listener = undefined;
  sendMessage.mockResolvedValue({ message_id: 555 });
  h.deleteMessage.mockResolvedValue(true);
  h.createBot.mockReturnValue({ api: { sendMessage, deleteMessage: h.deleteMessage } });
  h.getEnabledTelegramBot.mockResolvedValue({ encryptedToken: TOKEN });
  h.getLinkByUserId.mockResolvedValue({ telegramChatId: BigInt(777) });
  h.redis.setex.mockResolvedValue("OK");
  h.subscribeSessionEvents.mockImplementation(
    async (_sessionId: string, cb: (evt: { event: string; data: unknown }) => void) => {
      listener = cb;
      return unsubscribe;
    },
  );
});

async function openChannel() {
  return createTelegramApprovalChannel({
    userId: USER,
    encryptedToken: TOKEN,
    sessionId: SESSION,
  });
}

function approvalRequest(toolCallId = "tool-1") {
  return {
    event: "tool_approval_request",
    data: {
      toolCallId,
      toolName: "createDirectory",
      args: { path: "/tmp/x" },
      summary: "Create /tmp/x",
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    },
  };
}

describe("createTelegramApprovalChannel", () => {
  it("sends a card with buttons when the run asks for approval", async () => {
    await openChannel();

    listener!(approvalRequest());
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalled());

    const [chatId, text, options] = sendMessage.mock.calls[0]!;
    expect(chatId).toBe(777);
    expect(String(text)).toContain("Approval required");
    expect(String(text)).toContain("Create /tmp/x");
    expect(options.reply_markup.inline_keyboard[0]).toEqual([
      { text: "✅ Approve", callback_data: expect.stringMatching(/^a:[0-9a-f]{16}$/) },
      { text: "❌ Deny", callback_data: expect.stringMatching(/^d:[0-9a-f]{16}$/) },
    ]);
  });

  it("deletes the card when the approval resolves anywhere", async () => {
    await openChannel();

    listener!(approvalRequest());
    await vi.waitFor(() => expect(h.redis.setex).toHaveBeenCalled());

    listener!({
      event: "tool_approval_resolved",
      data: {
        sessionId: SESSION,
        toolCallId: "tool-1",
        toolName: "createDirectory",
        approved: true,
      },
    });
    await vi.waitFor(() => expect(h.deleteMessage).toHaveBeenCalledWith(777, 555));
  });

  it("deletes a card the run ends with still on screen", async () => {
    const channel = await openChannel();

    listener!(approvalRequest());
    await vi.waitFor(() => expect(h.redis.setex).toHaveBeenCalled());

    channel.stop();

    expect(unsubscribe).toHaveBeenCalled();
    await vi.waitFor(() => expect(h.deleteMessage).toHaveBeenCalledWith(777, 555));
  });

  it("deletes the card of an approval the run cancelled", async () => {
    await openChannel();

    listener!(approvalRequest());
    await vi.waitFor(() => expect(h.redis.setex).toHaveBeenCalled());

    listener!({
      event: "tool_approval_resolved",
      data: {
        sessionId: SESSION,
        toolCallId: "tool-1",
        toolName: "createDirectory",
        approved: false,
        cancelled: true,
      },
    });

    await vi.waitFor(() => expect(h.deleteMessage).toHaveBeenCalledWith(777, 555));
  });

  it("ignores events that are not about approvals", async () => {
    await openChannel();

    listener!({ event: "message_update", data: { content: "thinking" } });
    listener!({ event: "tool_execution_start", data: { toolCallId: "tool-1" } });
    await Promise.resolve();

    expect(sendMessage).not.toHaveBeenCalled();
    expect(h.redis.setex).not.toHaveBeenCalled();
  });

  it("deletes a card that lands after the run ended", async () => {
    // The send is slower than the run: the card must not sit on the phone for
    // the rest of its five minutes, approving nothing.
    let release!: (value: { message_id: number }) => void;
    sendMessage.mockImplementation(
      () =>
        new Promise<{ message_id: number }>((resolve) => {
          release = resolve;
        }),
    );

    const channel = await openChannel();
    listener!(approvalRequest());
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalled());

    channel.stop();
    release({ message_id: 556 });

    await vi.waitFor(() => expect(h.deleteMessage).toHaveBeenCalledWith(777, 556));
  });

  it("logs a card that could not be sent", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    sendMessage.mockRejectedValue(new Error("bot was blocked by the user"));

    await openChannel();
    listener!(approvalRequest());
    await vi.waitFor(() =>
      expect(errorSpy).toHaveBeenCalledWith(
        "Failed to send a Telegram approval card:",
        expect.any(Error),
      ),
    );

    errorSpy.mockRestore();
  });

  it("sends nothing when the user has no linked chat", async () => {
    h.getEnabledTelegramBot.mockResolvedValue(null);

    await openChannel();
    listener!(approvalRequest());
    await vi.waitFor(() => expect(h.getEnabledTelegramBot).toHaveBeenCalled());

    expect(sendMessage).not.toHaveBeenCalled();
  });
});
