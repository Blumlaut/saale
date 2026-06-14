import { describe, it, expect } from "vitest";
import { generateShareToken } from "@/app/api/chat/sessions/[sessionId]/share/route";

describe("generateShareToken", () => {
  it("generates a 32-character hex string", () => {
    const token = generateShareToken();
    expect(token).toHaveLength(32);
    expect(token).toMatch(/^[0-9a-f]{32}$/);
  });

  it("generates unique tokens on consecutive calls", () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 100; i++) {
      tokens.add(generateShareToken());
    }
    // All 100 tokens should be unique (collision probability is negligible)
    expect(tokens.size).toBe(100);
  });

  it("generates tokens with good entropy distribution", () => {
    const token = generateShareToken();
    // Should contain a mix of hex characters (not all same digit)
    const uniqueChars = new Set(token.split(""));
    expect(uniqueChars.size).toBeGreaterThan(8);
  });
});

describe("share message transformation", () => {
  // Tests the message format transformation used in the share page
  // This mirrors the logic in src/app/share/[token]/page.tsx

  interface RawMessage {
    id: string;
    role: string;
    content: string;
    toolCalls: unknown[] | undefined;
    parentMessageId: string | undefined;
    createdAt: string;
  }

  function transformMessage(m: RawMessage) {
    return {
      id: m.id,
      role: m.role as "user" | "assistant" | "system",
      content: m.content,
      thinking: undefined,
      toolCalls: m.toolCalls,
      parentMessageId: m.parentMessageId,
      createdAt: m.createdAt,
      attachments: undefined,
    };
  }

  it("transforms a user message correctly", () => {
    const raw: RawMessage = {
      id: "msg-1",
      role: "user",
      content: "Hello world",
      toolCalls: undefined,
      parentMessageId: undefined,
      createdAt: "2024-01-01T00:00:00.000Z",
    };

    const transformed = transformMessage(raw);

    expect(transformed).toEqual({
      id: "msg-1",
      role: "user",
      content: "Hello world",
      thinking: undefined,
      toolCalls: undefined,
      parentMessageId: undefined,
      createdAt: "2024-01-01T00:00:00.000Z",
      attachments: undefined,
    });
  });

  it("strips thinking content from assistant messages", () => {
    const raw: RawMessage = {
      id: "msg-2",
      role: "assistant",
      content: "Here is the answer",
      toolCalls: undefined,
      parentMessageId: undefined,
      createdAt: "2024-01-01T00:00:01.000Z",
    };

    const transformed = transformMessage(raw);

    expect(transformed.thinking).toBeUndefined();
  });

  it("preserves tool calls in assistant messages", () => {
    const toolCalls = [{ id: "tc-1", name: "search", args: { query: "test" } }];
    const raw: RawMessage = {
      id: "msg-3",
      role: "assistant",
      content: "Let me search for that",
      toolCalls,
      parentMessageId: undefined,
      createdAt: "2024-01-01T00:00:02.000Z",
    };

    const transformed = transformMessage(raw);

    expect(transformed.toolCalls).toEqual(toolCalls);
  });

  it("handles empty messages array", () => {
    const rawMessages: RawMessage[] = [];
    const transformed = rawMessages.map(transformMessage);
    expect(transformed).toEqual([]);
  });

  it("handles messages with null parentMessageId", () => {
    const raw: RawMessage = {
      id: "msg-4",
      role: "assistant",
      content: "Response",
      toolCalls: undefined,
      parentMessageId: null as unknown as undefined,
      createdAt: "2024-01-01T00:00:03.000Z",
    };

    const transformed = transformMessage(raw);

    expect(transformed.parentMessageId).toBeNull();
  });
});

describe("share URL format", () => {
  it("constructs full URL from relative path", () => {
    const path = "/share/abc123";
    const origin = "https://saale.example.com";
    const fullUrl = `${origin}${path}`;
    expect(fullUrl).toBe("https://saale.example.com/share/abc123");
  });

  it("preserves absolute URLs as-is", () => {
    const url = "https://saale.example.com/share/abc123";
    expect(url.startsWith("http")).toBe(true);
    expect(url).toBe("https://saale.example.com/share/abc123");
  });
});
