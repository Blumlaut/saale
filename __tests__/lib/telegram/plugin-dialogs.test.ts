import { describe, it, expect, vi, beforeEach } from "vitest";

// Dialogs live in Redis and settle over its pub/sub bus. the in-memory stand-in.
vi.mock("@/lib/redis", () => import("../../helpers/in-memory-redis"));

const TELEGRAM_USER_ID = BigInt(4242);
const TELEGRAM_CHAT_ID = BigInt(9001);

const sendMessage = vi.fn(async () => ({ message_id: 11 }));
vi.mock("@/lib/telegram/bot", () => ({
  getEnabledTelegramBot: vi.fn(async () => ({
    encryptedToken: "enc-token",
    botId: "bot-1",
    webhookSecret: "secret",
    enabled: true,
  })),
}));
vi.mock("@/lib/telegram/client", () => ({
  createBot: () => ({ api: { sendMessage } }),
  sendTelegramMessage: vi.fn(async () => undefined),
}));
vi.mock("@/lib/telegram/links", () => ({
  getLinkByUserId: vi.fn(async (userId: string) => ({
    userId,
    telegramUserId: TELEGRAM_USER_ID,
    telegramChatId: TELEGRAM_CHAT_ID,
  })),
  getLinkByTelegramUserId: vi.fn(async (telegramUserId: bigint) =>
    telegramUserId === TELEGRAM_USER_ID
      ? { userId: "user-1", telegramUserId, telegramChatId: TELEGRAM_CHAT_ID }
      : { userId: "someone-else", telegramUserId, telegramChatId: BigInt(9002) },
  ),
}));

import { resetMockRedis } from "../../helpers/in-memory-redis";
import {
  getPendingPluginUiRequests,
  requestPluginUi,
  type PluginUiRequestInput,
} from "@/lib/plugin-ui/requests";
import {
  handlePluginDialogCallback,
  notifyTelegramPluginUi,
  takePluginDialogReply,
} from "@/lib/telegram/plugin-dialogs";

/**
 * A dialog sent to Telegram and answered there settles the same Redis request
 * the browser polls, so whichever surface answers first wins.
 */
let sessionSeq = 0;
function base(overrides: Partial<PluginUiRequestInput> = {}): PluginUiRequestInput {
  sessionSeq += 1;
  return {
    sessionId: `tg-session-${sessionSeq}`,
    userId: "user-1",
    kind: "select",
    title: "Deploy saale@2026.10.26?",
    options: ["Deploy now", "Deploy to staging first", "Skip this release"],
    ...overrides,
  };
}

/** A `confirm` dialog: two buttons, no choices. */
function confirmDialog(): PluginUiRequestInput {
  const { options: _options, ...rest } = base();
  return { ...rest, kind: "confirm", title: "Delete the project?" };
}

/** An `input` dialog: no choices, answered by typing. */
function inputDialog(): PluginUiRequestInput {
  const { options: _options, ...rest } = base();
  return { ...rest, kind: "input", title: "Branch name?" };
}

/** Open a dialog, delivering it to Telegram the way the chat does. */
async function open(input: PluginUiRequestInput) {
  const answer = requestPluginUi(input, {
    onOpen: (request) => void notifyTelegramPluginUi(request),
  });
  await vi.waitFor(async () => {
    expect(await getPendingPluginUiRequests(input.sessionId)).toHaveLength(1);
  });
  await vi.waitFor(() => {
    expect(sendMessage).toHaveBeenCalled();
  });
  // Wrapped: an async helper would flatten the promise and wait for the answer.
  return { answer };
}

/** The `callback_data` of the button with this label on the last keyboard sent. */
function buttonData(label: string): string {
  const call = sendMessage.mock.calls.at(-1) as unknown as [
    number,
    string,
    { reply_markup: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } },
  ];
  const rows = call[2].reply_markup.inline_keyboard;
  for (const row of rows) {
    for (const button of row) {
      if (button.text.includes(label)) return button.callback_data;
    }
  }
  throw new Error(`no button labelled "${label}"`);
}

beforeEach(() => {
  resetMockRedis();
  sendMessage.mockClear();
});

describe("plugin dialogs on Telegram", () => {
  it("sends a select as an inline keyboard and answers with the tapped option", async () => {
    const input = base();
    const { answer } = await open(input);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [chatId, text] = sendMessage.mock.calls[0] as unknown as [number, string];
    expect(chatId).toBe(9001);
    expect(text).toContain("Deploy saale@2026.10.26?");

    const result = await handlePluginDialogCallback(
      buttonData("Deploy to staging first"),
      TELEGRAM_USER_ID,
    );
    expect(result.handled).toBe(true);
    expect(result.message).toContain("Deploy to staging first");

    await expect(answer).resolves.toEqual({ value: "Deploy to staging first" });
    expect(await getPendingPluginUiRequests(input.sessionId)).toHaveLength(0);
  });

  it("answers a confirm with the pressed button", async () => {
    const { answer } = await open(confirmDialog());

    const result = await handlePluginDialogCallback(buttonData("Confirm"), TELEGRAM_USER_ID);
    expect(result.handled).toBe(true);
    await expect(answer).resolves.toEqual({ confirmed: true });
  });

  it("dismisses the dialog when the user drops it", async () => {
    const { answer } = await open(base());

    await handlePluginDialogCallback(buttonData("Dismiss"), TELEGRAM_USER_ID);

    // A dismissal is the plugin's "not available", like Pi's own no-op UI.
    await expect(answer).resolves.toEqual({ cancelled: true });
  });

  it("refuses a press from another account", async () => {
    const { answer } = await open(base());

    const result = await handlePluginDialogCallback(buttonData("Deploy now"), BigInt(7777));
    expect(result.handled).toBe(true);
    expect(result.message).toContain("different account");

    // The dialog is untouched, so the owner can still answer it.
    const owned = await handlePluginDialogCallback(buttonData("Deploy now"), TELEGRAM_USER_ID);
    expect(owned.message).toContain("Deploy now");
    await expect(answer).resolves.toEqual({ value: "Deploy now" });
  });

  it("reports a second answer as already settled", async () => {
    const { answer } = await open(base());

    await handlePluginDialogCallback(buttonData("Deploy now"), TELEGRAM_USER_ID);
    await expect(answer).resolves.toEqual({ value: "Deploy now" });

    const again = await handlePluginDialogCallback(buttonData("Deploy now"), TELEGRAM_USER_ID);
    expect(again.handled).toBe(true);
    expect(again.message).toContain("expired");
  });

  it("takes a typed reply as the answer to an input dialog, once", async () => {
    const input = inputDialog();
    const { answer } = await open(input);

    const reply = {
      userId: "user-1",
      telegramUserId: TELEGRAM_USER_ID,
      telegramChatId: TELEGRAM_CHAT_ID,
      text: "release/2026.10.26",
    };
    await expect(takePluginDialogReply(reply)).resolves.toEqual({ consumed: true });
    await expect(answer).resolves.toEqual({ value: "release/2026.10.26" });

    // The next message is a normal prompt again.
    await expect(takePluginDialogReply({ ...reply, text: "hello" })).resolves.toEqual({
      consumed: false,
    });
  });

  it("tells the user when the dialog is gone instead of running their text", async () => {
    const input = inputDialog();
    const { answer } = await open(input);

    // Answered in the browser while they were typing.
    const [pending] = await getPendingPluginUiRequests(input.sessionId);
    const { resolvePluginUiRequest } = await import("@/lib/plugin-ui/requests");
    await resolvePluginUiRequest(input.sessionId, pending!.id, { cancelled: true });
    await answer;

    const result = await takePluginDialogReply({
      userId: "user-1",
      telegramUserId: TELEGRAM_USER_ID,
      telegramChatId: TELEGRAM_CHAT_ID,
      text: "release/2026.10.26",
    });
    expect(result.consumed).toBe(true);
    expect(result.note).toContain("already answered");
  });
});
