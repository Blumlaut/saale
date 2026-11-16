import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockApi } = vi.hoisted(() => ({
  mockApi: {
    setMyCommands: vi.fn(),
    deleteMyCommands: vi.fn(),
    setWebhook: vi.fn(),
    getChat: vi.fn(),
    getChatMemberCount: vi.fn(),
  },
}));

vi.mock("grammy", () => ({
  Bot: class {
    api = mockApi;
  },
  InputFile: class {},
}));

vi.mock("@/lib/crypto", () => ({
  decrypt: (value: string) => value,
}));

const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

import { getTelegramChatInfo, registerBotCommands, registerWebhook } from "@/lib/telegram/client";

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.setMyCommands.mockResolvedValue(true);
  mockApi.deleteMyCommands.mockResolvedValue(true);
  mockApi.setWebhook.mockResolvedValue(true);
});

describe("registerBotCommands", () => {
  it("keeps the command menu in private chats only", async () => {
    expect(await registerBotCommands("token")).toBe(true);

    expect(mockApi.setMyCommands).toHaveBeenCalledTimes(1);
    const [commands, options] = mockApi.setMyCommands.mock.calls[0] ?? [];
    expect(commands.length).toBeGreaterThan(0);
    expect(options).toEqual({ scope: { type: "all_private_chats" } });
  });

  it("clears the scopes a group would inherit", async () => {
    await registerBotCommands("token");

    const scopes = mockApi.deleteMyCommands.mock.calls.map(
      (call) => (call[0] as { scope: { type: string } }).scope.type,
    );
    expect(scopes).toContain("default");
    expect(scopes).toContain("all_group_chats");
  });

  it("still registers the webhook when clearing the group menu fails", async () => {
    mockApi.deleteMyCommands.mockRejectedValue(new Error("telegram unreachable"));

    expect(await registerWebhook("token", "secret")).toBe(true);
    expect(mockApi.setWebhook).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy).toHaveBeenCalled();
  });
});

describe("getTelegramChatInfo", () => {
  it("asks for both facts together, each with a deadline", async () => {
    mockApi.getChat.mockResolvedValue({ id: -100, type: "supergroup", title: "CVEs" });
    mockApi.getChatMemberCount.mockResolvedValue(12);

    const info = await getTelegramChatInfo("token", BigInt(-100));

    expect(info).toEqual({
      chatId: BigInt(-100),
      title: "CVEs",
      kind: "supergroup",
      memberCount: 12,
    });
    expect(mockApi.getChat.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);
    expect(mockApi.getChatMemberCount.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);
  });

  it("keeps the title when the member count is refused", async () => {
    mockApi.getChat.mockResolvedValue({ id: -100, type: "supergroup", title: "CVEs" });
    mockApi.getChatMemberCount.mockRejectedValue(new Error("not enough rights"));

    const info = await getTelegramChatInfo("token", BigInt(-100));

    expect(info.title).toBe("CVEs");
    expect(info.memberCount).toBeNull();
    expect(consoleWarnSpy).toHaveBeenCalled();
  });
});
