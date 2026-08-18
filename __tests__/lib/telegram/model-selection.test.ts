import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks ───────────────────────────────────────────────────────────────────

const {
  mockTelegramAccount,
  mockAgentDefinition,
  mockBuildModelRuntime,
  mockResolveModelForPurpose,
  mockEnsureDefinition,
  mockCreateBot,
  mockSendMessage,
  mockRandomBytes,
} = vi.hoisted(() => ({
  mockTelegramAccount: { findUnique: vi.fn() },
  mockAgentDefinition: { update: vi.fn() },
  mockBuildModelRuntime: vi.fn(),
  mockResolveModelForPurpose: vi.fn(),
  mockEnsureDefinition: vi.fn(),
  mockCreateBot: vi.fn(),
  mockSendMessage: vi.fn(),
  mockRandomBytes: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    telegramAccount: mockTelegramAccount,
    agentDefinition: mockAgentDefinition,
  },
}));

vi.mock("@/lib/redis", () => import("../../helpers/in-memory-redis"));
import { resetMockRedis } from "../../helpers/in-memory-redis";

vi.mock("@/lib/pi/models", () => ({
  buildModelRuntime: mockBuildModelRuntime,
}));

vi.mock("@/lib/pi/model-resolution", () => ({
  resolveModelForPurpose: mockResolveModelForPurpose,
}));

vi.mock("@/lib/telegram/processor", () => ({
  ensureTelegramAgentDefinition: mockEnsureDefinition,
}));

vi.mock("@/lib/telegram/client", () => ({
  createBot: mockCreateBot,
  sendTelegramMessage: mockSendMessage,
}));

vi.mock("crypto", async (importOriginal) => ({
  ...(await importOriginal<typeof import("crypto")>()),
  randomBytes: mockRandomBytes,
}));

import { sendModelPicker, handleModelCallback } from "@/lib/telegram/model-selection";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Deterministic 16-hex-char callback token. */
const TOKEN = "0123456789abcdef";

const MODELS = [
  { provider: "anthropic", id: "claude-sonnet-4", name: "claude-sonnet-4" },
  { provider: "openai", id: "gpt-4o", name: "gpt-4o" },
  { provider: "openai", id: "gpt-4o-mini", name: "gpt-4o-mini" },
  { provider: "anthropic", id: "claude-haiku-4", name: "claude-haiku-4" },
];

function makeBot() {
  return {
    api: {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 42 }),
      editMessageText: vi.fn().mockResolvedValue({ ok: true }),
    },
  };
}

const MESSAGE = { chat: { id: 123 }, message_id: 42 };

beforeEach(() => {
  vi.clearAllMocks();
  resetMockRedis();

  mockRandomBytes.mockReturnValue(Buffer.from(TOKEN, "hex"));
  mockSendMessage.mockResolvedValue([42]);
  mockBuildModelRuntime.mockResolvedValue({ modelRuntime: {}, models: MODELS });
  mockResolveModelForPurpose.mockResolvedValue({ provider: "anthropic", name: "claude-default" });
  mockEnsureDefinition.mockResolvedValue({
    id: "def-1",
    systemPrompt: null,
    toolConfig: null,
    modelId: null,
    thinkingLevel: "off",
  });
  mockTelegramAccount.findUnique.mockResolvedValue({
    id: "acc-1",
    userId: "user-1",
    encryptedToken: "enc-token",
  });
  mockCreateBot.mockImplementation(() => makeBot());
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("sendModelPicker", () => {
  it("sends a picker with an inline keyboard listing the user's models", async () => {
    await sendModelPicker({
      userId: "user-1",
      encryptedToken: "enc-token",
      telegramChatId: BigInt("123"),
      replyToMessageId: 7,
    });

    expect(mockBuildModelRuntime).toHaveBeenCalledWith("user-1");

    const bot = mockCreateBot.mock.results[0]!.value;
    expect(bot.api.sendMessage).toHaveBeenCalledTimes(1);
    const [, , options] = bot.api.sendMessage.mock.calls[0] as [
      number,
      string,
      { reply_markup: { inline_keyboard: unknown[][] } },
    ];
    expect(options.reply_markup.inline_keyboard.length).toBeGreaterThan(0);

    // One button per model, in order
    const modelButtons = options.reply_markup.inline_keyboard
      .flat()
      .filter((b) => (b as { callback_data: string }).callback_data.startsWith(`m:${TOKEN}:s:`));
    expect(modelButtons).toHaveLength(MODELS.length);
  });

  it("shows provider prefixes when multiple providers are configured", async () => {
    await sendModelPicker({
      userId: "user-1",
      encryptedToken: "enc-token",
      telegramChatId: BigInt("123"),
    });

    const bot = mockCreateBot.mock.results[0]!.value;
    const [, , options] = bot.api.sendMessage.mock.calls[0] as [
      number,
      string,
      { reply_markup: { inline_keyboard: { text: string }[][] } },
    ];
    const labels = options.reply_markup.inline_keyboard.flat().map((b) => b.text);
    expect(labels).toContain("anthropic:claude-sonnet-4");
    expect(labels).toContain("openai:gpt-4o");
  });

  it("informs the user when no models are configured", async () => {
    mockBuildModelRuntime.mockResolvedValue({ modelRuntime: {}, models: [] });

    await sendModelPicker({
      userId: "user-1",
      encryptedToken: "enc-token",
      telegramChatId: BigInt("123"),
    });

    expect(mockSendMessage).toHaveBeenCalledWith(
      "enc-token",
      BigInt("123"),
      expect.stringContaining("No AI models are available"),
      undefined,
    );
    expect(mockCreateBot).not.toHaveBeenCalled();
  });
});

describe("handleModelCallback", () => {
  it("ignores callbacks that are not model picker callbacks", async () => {
    const result = await handleModelCallback("acc-1", "a:deadbeefdeadbeef", MESSAGE);
    expect(result.handled).toBe(false);

    const result2 = await handleModelCallback("acc-1", "random-data", MESSAGE);
    expect(result2.handled).toBe(false);
  });

  it("reports expired pickers", async () => {
    const result = await handleModelCallback("acc-1", `m:${TOKEN}:s:1`, MESSAGE);
    expect(result.handled).toBe(true);
    expect(result.message).toContain("expired");
    expect(mockAgentDefinition.update).not.toHaveBeenCalled();
  });

  it("selects a model and persists it on the telegram agent definition", async () => {
    await sendModelPicker({
      userId: "user-1",
      encryptedToken: "enc-token",
      telegramChatId: BigInt("123"),
    });

    const result = await handleModelCallback("acc-1", `m:${TOKEN}:s:1`, MESSAGE);

    expect(result.handled).toBe(true);
    expect(result.message).toContain("gpt-4o");
    expect(mockAgentDefinition.update).toHaveBeenCalledWith({
      where: { id: "def-1" },
      data: { modelId: "openai:gpt-4o" },
    });

    // Picker message is replaced with a confirmation (keyboard cleared)
    const bot = mockCreateBot.mock.results[1]!.value;
    expect(bot.api.editMessageText).toHaveBeenCalledWith(
      123,
      42,
      expect.stringContaining("Model set"),
      expect.objectContaining({ parse_mode: "HTML" }),
    );

    // The pick session is consumed — a second press reports expiry.
    const again = await handleModelCallback("acc-1", `m:${TOKEN}:s:1`, MESSAGE);
    expect(again.message).toContain("expired");
  });

  it("reverts to the default model on reset", async () => {
    await sendModelPicker({
      userId: "user-1",
      encryptedToken: "enc-token",
      telegramChatId: BigInt("123"),
    });

    const result = await handleModelCallback("acc-1", `m:${TOKEN}:r`, MESSAGE);

    expect(result.handled).toBe(true);
    expect(mockAgentDefinition.update).toHaveBeenCalledWith({
      where: { id: "def-1" },
      data: { modelId: null },
    });
  });

  it("navigates pages without persisting anything", async () => {
    // 20 models → 4 pages of 6
    const manyModels = Array.from({ length: 20 }, (_, i) => ({
      provider: "openai",
      id: `model-${i}`,
      name: `model-${i}`,
    }));
    mockBuildModelRuntime.mockResolvedValue({ modelRuntime: {}, models: manyModels });

    await sendModelPicker({
      userId: "user-1",
      encryptedToken: "enc-token",
      telegramChatId: BigInt("123"),
    });

    const result = await handleModelCallback("acc-1", `m:${TOKEN}:p:2`, MESSAGE);

    expect(result.handled).toBe(true);
    expect(mockAgentDefinition.update).not.toHaveBeenCalled();

    const bot = mockCreateBot.mock.results[1]!.value;
    expect(bot.api.editMessageText).toHaveBeenCalledTimes(1);
    // Page 2 (0-indexed) shows models 12..17
    const [, , , options] = bot.api.editMessageText.mock.calls[0] as unknown[];
    const keyboard = (
      options as { reply_markup: { inline_keyboard: { callback_data: string }[][] } }
    ).reply_markup.inline_keyboard;
    const callbacks = keyboard.flat().map((b) => b.callback_data);
    expect(callbacks).toContain(`m:${TOKEN}:s:12`);
    expect(callbacks).toContain(`m:${TOKEN}:s:17`);
    expect(callbacks).not.toContain(`m:${TOKEN}:s:18`);
  });

  it("clamps out-of-range page navigation", async () => {
    const manyModels = Array.from({ length: 20 }, (_, i) => ({
      provider: "openai",
      id: `model-${i}`,
      name: `model-${i}`,
    }));
    mockBuildModelRuntime.mockResolvedValue({ modelRuntime: {}, models: manyModels });

    await sendModelPicker({
      userId: "user-1",
      encryptedToken: "enc-token",
      telegramChatId: BigInt("123"),
    });

    const result = await handleModelCallback("acc-1", `m:${TOKEN}:p:99`, MESSAGE);
    expect(result.handled).toBe(true);

    const bot = mockCreateBot.mock.results[1]!.value;
    const [, , , options] = bot.api.editMessageText.mock.calls[0] as unknown[];
    const keyboard = (
      options as { reply_markup: { inline_keyboard: { callback_data: string }[][] } }
    ).reply_markup.inline_keyboard;
    const callbacks = keyboard.flat().map((b) => b.callback_data);
    // Clamped to last page (models 18, 19)
    expect(callbacks).toContain(`m:${TOKEN}:s:18`);
    expect(callbacks).toContain(`m:${TOKEN}:s:19`);
  });

  it("rejects a model index outside the list", async () => {
    await sendModelPicker({
      userId: "user-1",
      encryptedToken: "enc-token",
      telegramChatId: BigInt("123"),
    });

    const result = await handleModelCallback("acc-1", `m:${TOKEN}:s:99`, MESSAGE);

    expect(result.handled).toBe(true);
    expect(result.message).toContain("not found");
    expect(mockAgentDefinition.update).not.toHaveBeenCalled();
  });

  it("enforces user isolation — a pick session cannot be resolved by another user", async () => {
    await sendModelPicker({
      userId: "user-1",
      encryptedToken: "enc-token",
      telegramChatId: BigInt("123"),
    });

    // The callback comes in for a different account (different user).
    mockTelegramAccount.findUnique.mockResolvedValue({
      id: "acc-2",
      userId: "user-2",
      encryptedToken: "enc-token-2",
    });

    const result = await handleModelCallback("acc-2", `m:${TOKEN}:s:1`, MESSAGE);

    expect(result.handled).toBe(false);
    expect(mockAgentDefinition.update).not.toHaveBeenCalled();
  });
});
