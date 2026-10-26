import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockApi } = vi.hoisted(() => ({
  mockApi: {
    setMyCommands: vi.fn(),
    deleteMyCommands: vi.fn(),
    setWebhook: vi.fn(),
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

import { registerBotCommands, registerWebhook } from "@/lib/telegram/client";

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
