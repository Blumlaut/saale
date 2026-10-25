import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The shared chat-row creation. Two entry points now use it  the web POST
 * route and the `chat_create` tool  so the sanitizing and the optional-field
 * handling have to hold for both.
 */

const mockCreate = vi.fn();
vi.mock("@/lib/db", () => ({
  prisma: {
    chatSession: { create: (...args: unknown[]) => mockCreate(...args) },
    appSettings: { findUnique: vi.fn(async () => null) },
  },
}));

import { createChatSessionRow, sanitizeChatTitle } from "@/lib/chat/create-session";

describe("sanitizeChatTitle", () => {
  it("defaults an empty title", () => {
    expect(sanitizeChatTitle(undefined)).toBe("New Chat");
    expect(sanitizeChatTitle(null)).toBe("New Chat");
    expect(sanitizeChatTitle("")).toBe("New Chat");
  });

  it("strips null bytes and caps the length", () => {
    expect(sanitizeChatTitle("a\0b")).toBe("ab");
    expect(sanitizeChatTitle("x".repeat(80))).toHaveLength(50);
  });
});

describe("createChatSessionRow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreate.mockImplementation(async (args: { data: Record<string, unknown> }) => ({
      id: args.data.id,
      title: args.data.title,
      createdAt: new Date("2025-01-01"),
    }));
  });

  it("creates a chat with a generated id and the user's defaults", async () => {
    const result = await createChatSessionRow("user-1", {
      title: "Trip planning",
      modelProvider: "anthropic",
      modelName: "claude-sonnet-4-5",
      thinkingLevel: "high",
      toolConfig: { email: true },
    });

    const data = mockCreate.mock.calls[0]![0].data as Record<string, unknown>;
    expect(data.userId).toBe("user-1");
    expect(data.title).toBe("Trip planning");
    // a title the caller gave is not one the title job may replace
    expect(data.titleSource).toBe("user");
    expect(data.temporary).toBe(false);
    expect(data.modelProvider).toBe("anthropic");
    expect(data.thinkingLevel).toBe("high");
    expect(data.toolConfig).toEqual({ email: true });
    expect(typeof data.id).toBe("string");
    expect(result).toEqual({
      id: data.id,
      title: "Trip planning",
      createdAt: new Date("2025-01-01"),
    });
  });

  it("keeps the id and the origin a watcher fire hands it", async () => {
    await createChatSessionRow("user-1", {
      id: "chat-bot",
      title: "PR bot: issue 14",
      projectId: "project-1",
      origin: "watcher",
      originId: "w-1",
      worktreeBranch: "watch/pr-bot/c-chatbot",
    });

    const data = mockCreate.mock.calls[0]![0].data as Record<string, unknown>;
    expect(data.id).toBe("chat-bot");
    expect(data.origin).toBe("watcher");
    expect(data.originId).toBe("w-1");
    expect(data.worktreeBranch).toBe("watch/pr-bot/c-chatbot");
  });

  it("omits fields the caller did not set so the schema defaults apply", async () => {
    await createChatSessionRow("user-1", { title: "Bare" });

    const data = mockCreate.mock.calls[0]![0].data as Record<string, unknown>;
    expect(data.modelProvider).toBeNull();
    expect(data.modelName).toBeNull();
    expect("thinkingLevel" in data).toBe(false);
    expect("toolConfig" in data).toBe(false);
    expect("origin" in data).toBe(false);
    expect("worktreeBranch" in data).toBe(false);
  });

  it("leaves an unnamed chat to the title job", async () => {
    await createChatSessionRow("user-1");

    const data = mockCreate.mock.calls[0]![0].data as Record<string, unknown>;
    expect(data.title).toBe("New Chat");
    expect(data.titleSource).toBe("default");
  });
});
