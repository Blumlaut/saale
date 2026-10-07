import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The Telegram adapter is transport only: it runs commands through the shared
 * executor and renders an interactive prompt as an inline keyboard. These tests
 * pin the wire format (callback data, paging, deferred execution) and the
 * isolation boundary between accounts.
 */

const {
  mockCreateBot,
  mockSendTelegramMessage,
  mockSendMessage,
  mockEditMessageText,
  mockAccountFindUnique,
  mockExecuteCommand,
} = vi.hoisted(() => ({
  mockCreateBot: vi.fn(),
  mockSendTelegramMessage: vi.fn(),
  mockSendMessage: vi.fn(),
  mockEditMessageText: vi.fn(),
  mockAccountFindUnique: vi.fn(),
  mockExecuteCommand: vi.fn(),
}));

vi.mock("@/lib/redis", () => import("../../helpers/in-memory-redis"));
vi.mock("@/lib/db", () => ({
  prisma: { telegramAccount: { findUnique: mockAccountFindUnique } },
}));
vi.mock("@/lib/telegram/client", () => ({
  createBot: mockCreateBot,
  sendTelegramMessage: mockSendTelegramMessage,
}));
vi.mock("@/lib/commands/execute", () => ({ executeCommand: mockExecuteCommand }));

import { resetMockRedis, getRedis } from "../../helpers/in-memory-redis";
import { handleCommandPromptCallback, handleTelegramCommand } from "@/lib/telegram/command-prompts";

const ACCOUNT_ID = "acc-1";
const USER_ID = "user-1";
const CHAT_ID = BigInt(4242);
const CALLBACK_MESSAGE = { chat: { id: 4242 }, message_id: 99 };

const COMMAND = {
  accountId: ACCOUNT_ID,
  userId: USER_ID,
  encryptedToken: "encrypted-token",
  telegramChatId: CHAT_ID,
  name: "model",
  args: "",
  replyToMessageId: 7,
};

const PROMPT = {
  title: "Model for this chat",
  description: "Applies to this conversation only.",
  options: [
    { value: "anthropic:claude-sonnet-4", label: "claude-sonnet-4", current: true },
    { value: "openai:gpt-5", label: "gpt-5" },
  ],
};

type Button = { text: string; callback_data: string };

/** Buttons of the keyboard sent by the most recent prompt. */
function sentKeyboard(): Button[][] {
  const call = mockSendMessage.mock.calls.at(-1);
  const options = call?.[2] as { reply_markup?: { inline_keyboard: Button[][] } } | undefined;
  return options?.reply_markup?.inline_keyboard ?? [];
}

function sentText(): string {
  return String(mockSendMessage.mock.calls.at(-1)?.[1] ?? "");
}

function tokenFrom(callbackData: string): string {
  return callbackData.split(":")[1]!;
}

describe("Telegram command adapter", () => {
  beforeEach(() => {
    resetMockRedis();
    vi.clearAllMocks();
    mockCreateBot.mockReturnValue({
      api: { sendMessage: mockSendMessage, editMessageText: mockEditMessageText },
    });
    mockSendTelegramMessage.mockResolvedValue([1]);
    mockSendMessage.mockResolvedValue({ message_id: 10 });
    mockEditMessageText.mockResolvedValue(true);
    mockAccountFindUnique.mockResolvedValue({
      id: ACCOUNT_ID,
      userId: USER_ID,
      encryptedToken: "encrypted-token",
    });
  });

  describe("handleTelegramCommand", () => {
    it("runs the command for the Telegram surface and replies with the outcome", async () => {
      mockExecuteCommand.mockResolvedValue({
        kind: "done",
        name: "stop",
        outcome: { message: "Stopped.", tone: "info" },
      });

      await handleTelegramCommand(COMMAND);

      expect(mockExecuteCommand).toHaveBeenCalledWith(
        "model",
        expect.objectContaining({
          surface: "telegram",
          userId: USER_ID,
          args: "",
          telegramChatId: CHAT_ID,
          encryptedToken: "encrypted-token",
        }),
      );
      expect(mockSendTelegramMessage).toHaveBeenCalledWith(
        "encrypted-token",
        CHAT_ID,
        "ℹ️ Stopped.",
        { replyToMessageId: 7 },
      );
    });

    it("replies with the warning icon when execution fails", async () => {
      mockExecuteCommand.mockResolvedValue({
        kind: "error",
        name: "model",
        error: "Unknown command: /model",
      });

      await handleTelegramCommand(COMMAND);

      expect(mockSendTelegramMessage).toHaveBeenCalledWith(
        "encrypted-token",
        CHAT_ID,
        "⚠️ Unknown command: /model",
        { replyToMessageId: 7 },
      );
    });

    it("asks for arguments threaded to the user's command message", async () => {
      mockExecuteCommand.mockResolvedValue({
        kind: "done",
        name: "stop",
        outcome: { message: "ok" },
      });

      await handleTelegramCommand({ ...COMMAND, replyToMessageId: undefined });

      expect(mockSendTelegramMessage).toHaveBeenCalledWith(
        "encrypted-token",
        CHAT_ID,
        "✅ ok",
        undefined,
      );
    });

    it("renders a prompt as an inline keyboard and stashes the options behind a token", async () => {
      mockExecuteCommand.mockResolvedValue({ kind: "prompt", name: "model", prompt: PROMPT });

      await handleTelegramCommand(COMMAND);

      const keyboard = sentKeyboard();
      expect(keyboard).toHaveLength(2);
      expect(keyboard[0]![0]!.text).toBe("✓ claude-sonnet-4");
      expect(keyboard[1]![0]!.text).toBe("gpt-5");

      const callbackData = keyboard[1]![0]!.callback_data;
      expect(callbackData).toMatch(/^c:[0-9a-f]{16}:s:1$/);

      const stored = await getRedis().get(`saale:command-prompt:${tokenFrom(callbackData)}`);
      expect(stored).not.toBeNull();
      expect(JSON.parse(stored!)).toMatchObject({
        userId: USER_ID,
        accountId: ACCOUNT_ID,
        command: "model",
        telegramChatId: "4242",
        replyToMessageId: 7,
        options: PROMPT.options,
      });

      expect(sentText()).toContain("Model for this chat");
      expect(sentText()).toContain("Applies to this conversation only.");
      expect(sentText()).not.toContain("Page");
    });

    it("paginates long option lists with navigation buttons", async () => {
      const options = Array.from({ length: 8 }, (_, index) => ({
        value: `p:${index}`,
        label: `Model ${index}`,
      }));
      mockExecuteCommand.mockResolvedValue({
        kind: "prompt",
        name: "model",
        prompt: { title: "Model", options },
      });

      await handleTelegramCommand(COMMAND);

      const keyboard = sentKeyboard();
      // Six options, then the navigation row.
      expect(keyboard).toHaveLength(7);
      expect(keyboard[6]!.map((button) => button.text)).toEqual(["1/2", "▶️"]);
      expect(keyboard[6]![1]!.callback_data).toMatch(/:p:1$/);
      expect(sentText()).toContain("Page 1/2");
    });

    it("explains itself instead of sending an empty keyboard", async () => {
      mockExecuteCommand.mockResolvedValue({
        kind: "prompt",
        name: "model",
        prompt: { title: "Model", options: [] },
      });

      await handleTelegramCommand(COMMAND);

      expect(sentKeyboard()).toEqual([]);
      expect(sentText()).toContain("/model");
      expect(sentText()).toContain("nothing to offer");
    });
  });

  describe("handleCommandPromptCallback", () => {
    /** Run a command that ends in a prompt, and return its first button. */
    async function openPrompt(options = PROMPT.options): Promise<Button> {
      mockExecuteCommand.mockResolvedValue({
        kind: "prompt",
        name: "model",
        prompt: { title: "Model for this chat", options },
      });
      await handleTelegramCommand(COMMAND);
      return sentKeyboard()[0]![0]!;
    }

    it("ignores callbacks that belong to another subsystem", async () => {
      await expect(handleCommandPromptCallback(ACCOUNT_ID, "a:deadbeefdeadbeef")).resolves.toEqual({
        handled: false,
      });
    });

    it("reports an expired prompt instead of failing silently", async () => {
      const result = await handleCommandPromptCallback(
        ACCOUNT_ID,
        `c:${"0".repeat(16)}:s:0`,
        CALLBACK_MESSAGE,
      );

      expect(result.handled).toBe(true);
      expect(result.message).toMatch(/expired/);
      expect(mockEditMessageText).not.toHaveBeenCalled();
    });

    it("refuses a token that belongs to another account", async () => {
      const button = await openPrompt();
      mockAccountFindUnique.mockResolvedValue({
        id: "acc-2",
        userId: "user-2",
        encryptedToken: "other-token",
      });

      const result = await handleCommandPromptCallback(
        "acc-2",
        button.callback_data,
        CALLBACK_MESSAGE,
      );

      expect(result).toEqual({ handled: false });
      expect(mockExecuteCommand).toHaveBeenCalledTimes(1); // only the prompt
      expect(mockEditMessageText).not.toHaveBeenCalled();
    });

    it("applies the chosen option and replaces the keyboard with the outcome", async () => {
      const button = await openPrompt();
      const token = tokenFrom(button.callback_data);
      mockExecuteCommand.mockResolvedValue({
        kind: "done",
        name: "model",
        outcome: { message: "Model set to anthropic:claude-sonnet-4.", tone: "success" },
      });

      const result = await handleCommandPromptCallback(
        ACCOUNT_ID,
        button.callback_data,
        CALLBACK_MESSAGE,
      );

      expect(mockExecuteCommand).toHaveBeenLastCalledWith(
        "model",
        expect.objectContaining({ surface: "telegram", userId: USER_ID, args: "" }),
        "anthropic:claude-sonnet-4",
      );
      expect(mockEditMessageText).toHaveBeenCalledWith(
        CALLBACK_MESSAGE.chat.id,
        CALLBACK_MESSAGE.message_id,
        "✅ Model set to anthropic:claude-sonnet-4.",
        { parse_mode: "HTML", reply_markup: { inline_keyboard: [] } },
      );
      expect(result.handled).toBe(true);
      // Single use: the token is gone once the choice is applied.
      expect(await getRedis().get(`saale:command-prompt:${token}`)).toBeNull();
    });

    it("reports an option that vanished between render and press", async () => {
      const button = await openPrompt();
      const stale = button.callback_data.replace(/:s:0$/, ":s:9");

      const result = await handleCommandPromptCallback(ACCOUNT_ID, stale, CALLBACK_MESSAGE);

      expect(result.handled).toBe(true);
      expect(result.message).toMatch(/no longer available/);
      expect(mockExecuteCommand).toHaveBeenCalledTimes(1); // only the prompt
    });

    it("pages the keyboard in place without running the command", async () => {
      const options = Array.from({ length: 8 }, (_, index) => ({
        value: `p:${index}`,
        label: `Model ${index}`,
      }));
      await openPrompt(options);
      const navigation = sentKeyboard()[6]!;
      const next = navigation[1]!;

      const result = await handleCommandPromptCallback(
        ACCOUNT_ID,
        next.callback_data,
        CALLBACK_MESSAGE,
      );

      expect(result).toEqual({ handled: true });
      expect(mockEditMessageText).toHaveBeenCalledTimes(1);
      const [, , text, options_] = mockEditMessageText.mock.calls[0]! as [
        number,
        number,
        string,
        { reply_markup: { inline_keyboard: Button[][] } },
      ];
      expect(text).toContain("Page 2/2");
      expect(options_.reply_markup.inline_keyboard[0]![0]!.callback_data).toMatch(/:s:6$/);
      expect(mockExecuteCommand).toHaveBeenCalledTimes(1); // only the prompt
    });

    it("acknowledges the page indicator without changing anything", async () => {
      const options = Array.from({ length: 8 }, (_, index) => ({
        value: `p:${index}`,
        label: `Model ${index}`,
      }));
      await openPrompt(options);
      const indicator = sentKeyboard()[6]![0]!;

      const result = await handleCommandPromptCallback(
        ACCOUNT_ID,
        indicator.callback_data,
        CALLBACK_MESSAGE,
      );

      expect(result).toEqual({ handled: true });
      expect(mockEditMessageText).not.toHaveBeenCalled();
    });
  });
});
