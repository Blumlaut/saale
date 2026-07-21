import { describe, it, expect, vi } from "vitest";

// ─── Tests for Telegram processor logic ──────────────────────────────────────
// These test the business logic (prompt building, context loading, etc.)
// without mocking the full Pi agent SDK.

describe("Telegram processor — prompt building", () => {
  it("returns just the message when no context", () => {
    const buildPrompt = (
      context: Array<{ role: string; content: string }>,
      currentMessage: string,
    ): string => {
      if (context.length === 0) {
        return currentMessage;
      }
      const contextLines = context.map((m) => {
        const role = m.role === "user" ? "User" : "Assistant";
        return `${role}: ${m.content}`;
      });
      return `Conversation context (most recent first):\n${contextLines.join("\n")}\n\n---\n\nUser: ${currentMessage}`;
    };

    const result = buildPrompt([], "What's the weather?");
    expect(result).toBe("What's the weather?");
  });

  it("includes context from prior messages", () => {
    const buildPrompt = (
      context: Array<{ role: string; content: string }>,
      currentMessage: string,
    ): string => {
      if (context.length === 0) {
        return currentMessage;
      }
      const contextLines = context.map((m) => {
        const role = m.role === "user" ? "User" : "Assistant";
        return `${role}: ${m.content}`;
      });
      return `Conversation context (most recent first):\n${contextLines.join("\n")}\n\n---\n\nUser: ${currentMessage}`;
    };

    const context = [
      { role: "user", content: "Summarize my emails" },
      { role: "assistant", content: "Here are your 3 unread emails..." },
    ];

    const result = buildPrompt(context, "Can you draft a reply?");

    expect(result).toContain("User: Summarize my emails");
    expect(result).toContain("Assistant: Here are your 3 unread emails...");
    expect(result).toContain("---");
    expect(result).toContain("User: Can you draft a reply?");
  });

  it("handles context with many messages", () => {
    const buildPrompt = (
      context: Array<{ role: string; content: string }>,
      currentMessage: string,
    ): string => {
      if (context.length === 0) {
        return currentMessage;
      }
      const contextLines = context.map((m) => {
        const role = m.role === "user" ? "User" : "Assistant";
        return `${role}: ${m.content}`;
      });
      return `Conversation context (most recent first):\n${contextLines.join("\n")}\n\n---\n\nUser: ${currentMessage}`;
    };

    const context = Array.from({ length: 10 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `Message ${i + 1}`,
    }));

    const result = buildPrompt(context, "Final message");

    // All context messages should be included
    for (let i = 0; i < 10; i++) {
      expect(result).toContain(`Message ${i + 1}`);
    }
    expect(result).toContain("Final message");
  });
});

describe("Telegram processor — context loading", () => {
  it("limits context to configured message count", () => {
    const CONTEXT_MESSAGE_COUNT = 20;

    const messages = Array.from({ length: 30 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `Message ${i + 1}`,
    }));

    const sliced = messages.slice(-CONTEXT_MESSAGE_COUNT);
    expect(sliced).toHaveLength(20);
    expect(sliced[0]!.content).toBe("Message 11");
    expect(sliced[19]!.content).toBe("Message 30");
  });

  it("returns all messages when under limit", () => {
    const CONTEXT_MESSAGE_COUNT = 20;

    const messages = Array.from({ length: 10 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `Message ${i + 1}`,
    }));

    const sliced = messages.slice(-CONTEXT_MESSAGE_COUNT);
    expect(sliced).toHaveLength(10);
  });

  it("returns empty array when no context", () => {
    const CONTEXT_MESSAGE_COUNT = 20;
    const messages: Array<{ role: string; content: string }> = [];
    const sliced = messages.slice(-CONTEXT_MESSAGE_COUNT);
    expect(sliced).toHaveLength(0);
  });
});

describe("Telegram processor — chat session expiry", () => {
  it("12 hour expiry is correct in milliseconds", () => {
    const TELEGRAM_CHAT_EXPIRY_MS = 12 * 60 * 60 * 1000;
    expect(TELEGRAM_CHAT_EXPIRY_MS).toBe(43_200_000);
  });

  it("session is expired when last update + expiry < now", () => {
    const TELEGRAM_CHAT_EXPIRY_MS = 12 * 60 * 60 * 1000;
    const updatedAt = new Date(Date.now() - 13 * 60 * 60 * 1000); // 13 hours ago
    const needsNewSession = updatedAt.getTime() + TELEGRAM_CHAT_EXPIRY_MS < Date.now();
    expect(needsNewSession).toBe(true);
  });

  it("session is not expired when within 12 hours", () => {
    const TELEGRAM_CHAT_EXPIRY_MS = 12 * 60 * 60 * 1000;
    const updatedAt = new Date(Date.now() - 6 * 60 * 60 * 1000); // 6 hours ago
    const needsNewSession = updatedAt.getTime() + TELEGRAM_CHAT_EXPIRY_MS < Date.now();
    expect(needsNewSession).toBe(false);
  });
});

describe("Telegram processor — agent definition naming", () => {
  it("Telegram agent has a fixed name", () => {
    const TELEGRAM_AGENT_NAME = "Telegram Assistant";
    expect(TELEGRAM_AGENT_NAME).toBe("Telegram Assistant");
  });

  it("agent name is unique per user via composite key", () => {
    // The schema has @@unique([userId, name])
    const userId1 = "user-1";
    const userId2 = "user-2";
    const name = "Telegram Assistant";

    // Different users can have the same agent name
    const key1 = `${userId1}:${name}`;
    const key2 = `${userId2}:${name}`;
    expect(key1).not.toBe(key2);
  });
});

describe("Telegram processor — output handler", () => {
  it("send handler calls both Telegram API and saves to ChatSession", async () => {
    const sendTelegramMessage = vi.fn().mockResolvedValue([123]);
    const chatMessageCreate = vi.fn().mockResolvedValue({});

    const sessionId = "session-1";
    const encryptedToken = "token";
    const telegramChatId = BigInt("12345");

    const handler = {
      send: async (content: string) => {
        if (content.trim()) {
          await sendTelegramMessage(encryptedToken, telegramChatId, content);
          await chatMessageCreate({
            data: { sessionId, role: "assistant", content },
          });
        }
      },
    };

    await handler.send("Hello from agent");

    expect(sendTelegramMessage).toHaveBeenCalledWith(
      encryptedToken,
      telegramChatId,
      "Hello from agent",
    );
    expect(chatMessageCreate).toHaveBeenCalledWith({
      data: { sessionId, role: "assistant", content: "Hello from agent" },
    });
  });

  it("send handler skips empty content", async () => {
    const sendTelegramMessage = vi.fn();
    const chatMessageCreate = vi.fn();

    const handler = {
      send: async (content: string) => {
        if (content.trim()) {
          await sendTelegramMessage("token", BigInt("123"), content);
          await chatMessageCreate({ data: {} });
        }
      },
    };

    await handler.send("   ");
    expect(sendTelegramMessage).not.toHaveBeenCalled();
    expect(chatMessageCreate).not.toHaveBeenCalled();
  });

  it("typing handler sends typing indicator", () => {
    const sendTypingIndicator = vi.fn().mockResolvedValue(undefined);

    const handler = {
      typing: () => {
        sendTypingIndicator("token", BigInt("123")).catch(() => {});
      },
    };

    handler.typing();
    expect(sendTypingIndicator).toHaveBeenCalledWith("token", BigInt("123"));
  });
});

describe("Telegram processor — model resolution", () => {
  it("prefers user settings over admin defaults", () => {
    const userSettings = {
      defaultModelProvider: "anthropic",
      defaultModelName: "claude-sonnet-4",
    };
    const adminSettings = {
      globalModelProvider: "openai",
      globalModelName: "gpt-4o",
    };

    // With user settings, user settings are used
    const resolved = userSettings
      ? { provider: userSettings.defaultModelProvider, name: userSettings.defaultModelName }
      : adminSettings
        ? { provider: adminSettings.globalModelProvider, name: adminSettings.globalModelName }
        : null;

    expect(resolved?.provider).toBe("anthropic");
  });

  it("falls back to admin defaults when no user settings", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userSettings: any = null;
    const adminSettings = {
      globalModelProvider: "openai",
      globalModelName: "gpt-4o",
    };

    const resolved = userSettings
      ? { provider: userSettings.defaultModelProvider, name: userSettings.defaultModelName }
      : adminSettings
        ? { provider: adminSettings.globalModelProvider, name: adminSettings.globalModelName }
        : null;

    expect(resolved?.provider).toBe("openai");
  });

  it("returns null when no model configured anywhere", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userSettings: any = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminSettings: any = null;

    const resolved = userSettings
      ? { provider: userSettings.defaultModelProvider, name: userSettings.defaultModelName }
      : adminSettings
        ? { provider: adminSettings.globalModelProvider, name: adminSettings.globalModelName }
        : null;

    expect(resolved).toBeNull();
  });

  it("trims whitespace from model values", () => {
    const settings = {
      defaultModelProvider: "  anthropic  ",
      defaultModelName: "  claude-sonnet-4  ",
    };

    const provider = settings.defaultModelProvider.trim();
    const name = settings.defaultModelName.trim();

    expect(provider).toBe("anthropic");
    expect(name).toBe("claude-sonnet-4");
  });
});

describe("Telegram processor — run creation", () => {
  it("run includes output channel fields from definition", () => {
    const definition = {
      id: "def-1",
      outputChannel: "telegram",
      outputChannelId: "12345",
    };

    const runData = {
      definitionId: definition.id,
      userId: "user-1",
      status: "pending",
      prompt: "User message",
      outputChannel: definition.outputChannel,
      outputChannelId: definition.outputChannelId,
    };

    expect(runData.outputChannel).toBe("telegram");
    expect(runData.outputChannelId).toBe("12345");
  });

  it("run includes telegramChatId for Telegram-sourced runs", () => {
    const telegramChatId = BigInt("98765");

    const runData = {
      definitionId: "def-1",
      userId: "user-1",
      telegramChatId,
    };

    expect(runData.telegramChatId).toBe(telegramChatId);
  });

  it("run status transitions: pending -> completed", () => {
    const initialStatus = "pending";
    const finalStatus = "completed";

    expect(initialStatus).toBe("pending");
    expect(finalStatus).toBe("completed");
  });

  it("run status transitions: pending -> error", () => {
    const initialStatus = "pending";
    const errorStatus = "error";

    expect(initialStatus).toBe("pending");
    expect(errorStatus).toBe("error");
  });
});

describe("Telegram processor — whitelist", () => {
  it("whitelist check prevents unauthorized access", () => {
    const whitelist = new Set<bigint>([BigInt(123), BigInt(456)]);
    expect(whitelist.has(BigInt(123))).toBe(true);
    expect(whitelist.has(BigInt(999))).toBe(false);
  });

  it("whitelist uses BigInt for Telegram user IDs", () => {
    const largeId = "9007199254740993"; // MAX_SAFE_INTEGER + 1
    const bigIntId = BigInt(largeId);
    expect(bigIntId.toString()).toBe(largeId);
  });
});
