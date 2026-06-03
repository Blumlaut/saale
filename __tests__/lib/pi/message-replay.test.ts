import { describe, it, expect } from "vitest";
import {
  normalizeToolResult,
  buildToolResultMessage,
  buildAssistantMessage,
  buildUserMessage,
  parseStoredToolCalls,
  buildHistoryMessages,
  type StoredMessage,
  type StoredToolCall,
  type ResolvedModel,
  type BuildHistoryOptions,
} from "@/lib/pi/message-replay";

/** Convert a ResolvedModel to BuildHistoryOptions */
function toOptions(model: ResolvedModel | undefined): BuildHistoryOptions {
  return {
    api: model?.api,
    provider: model?.provider,
    id: model?.id,
  };
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

const TEST_TIMESTAMP = 1700000000000;

const mockModel: ResolvedModel = {
  api: "anthropic-messages",
  provider: "anthropic",
  id: "claude-sonnet-4-5-20250514",
};

const mockOpenAiModel: ResolvedModel = {
  api: "openai-completions",
  provider: "custom",
  id: "gpt-4o",
};

function makeToolCall(overrides: Partial<StoredToolCall> = {}): StoredToolCall {
  return {
    id: "toolu_abc123",
    name: "mail_read",
    args: { ids: ["msg_1"] },
    result: undefined,
    isError: undefined,
    ...overrides,
  };
}

function makeToolResult(text: string) {
  return { content: [{ type: "text", text }] };
}

// ─── normalizeToolResult ─────────────────────────────────────────────────────

describe("normalizeToolResult", () => {
  it("extracts text from a structured tool result", () => {
    const result = makeToolResult('{"id":"msg_1","subject":"Hello"}');
    expect(normalizeToolResult(result)).toBe('{"id":"msg_1","subject":"Hello"}');
  });

  it("passes through plain strings unchanged", () => {
    expect(normalizeToolResult("already a string")).toBe("already a string");
  });

  it("extracts text from multi-block content (text blocks only)", () => {
    const result = {
      content: [
        { type: "text", text: "part1" },
        { type: "text", text: "part2" },
      ],
    };
    expect(normalizeToolResult(result)).toBe("part1part2");
  });

  it("ignores non-text content blocks", () => {
    const result = {
      content: [
        { type: "image", source: "..." },
        { type: "text", text: "only text" },
      ],
    };
    expect(normalizeToolResult(result)).toBe("only text");
  });

  it("falls back to JSON.stringify for unexpected shapes", () => {
    expect(normalizeToolResult({ foo: 42 })).toBe('{"foo":42}');
    expect(normalizeToolResult(null)).toBe("null");
    // JSON.stringify(undefined) returns undefined, not "undefined"
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON.stringify(undefined) returns the undefined value
    expect(normalizeToolResult(undefined)).toBe(undefined as any);
    expect(normalizeToolResult([1, 2, 3])).toBe("[1,2,3]");
  });

  it("handles empty content array", () => {
    expect(normalizeToolResult({ content: [] })).toBe("");
  });

  it("handles content with missing text field", () => {
    const result = { content: [{ type: "text" }] };
    expect(normalizeToolResult(result)).toBe("");
  });

  it("handles content with null text field", () => {
    const result = { content: [{ type: "text", text: null }] };
    expect(normalizeToolResult(result)).toBe("");
  });

  it("handles large JSON responses (mail_read with bodyText)", () => {
    const largeBody = "Eine Nachricht von Pavan Davuluri.\n\u200c".repeat(100);
    const result = makeToolResult(JSON.stringify([{ id: "msg_1", bodyText: largeBody }]));
    const normalized = normalizeToolResult(result);
    expect(normalized).toBe(JSON.stringify([{ id: "msg_1", bodyText: largeBody }]));
    // Crucially: NOT double-encoded
    expect(normalized).not.toContain('\\"content\\"');
    expect(normalized).not.toContain('\\"type\\"');
  });

  it("does NOT double-encode the result", () => {
    // This is the exact bug we fixed: JSON.stringify({ content: [...] })
    // would produce "{\"content\":[{\"type\":\"text\",...}]}" which when
    // wrapped again in [{ type: "text", text: tc.result }] would be seen
    // by the LLM as the literal string {"content":[...]}.
    const result = makeToolResult('{"key":"value"}');
    const normalized = normalizeToolResult(result);

    // The normalized result should be the raw text, not a JSON-encoded wrapper
    expect(normalized).toBe('{"key":"value"}');
    expect(normalized.startsWith('{"content"')).toBe(false);
    expect(normalized).not.toContain('\\"');
  });
});

// ─── buildToolResultMessage ──────────────────────────────────────────────────

describe("buildToolResultMessage", () => {
  it("uses toolCallId (not toolUseId)", () => {
    const tc = makeToolCall({ result: "some result" });
    const msg = buildToolResultMessage(tc, TEST_TIMESTAMP);

    expect(msg.toolCallId).toBe("toolu_abc123");
    expect(msg.toolUseId).toBeUndefined();
  });

  it("wraps result in content array with text block", () => {
    const tc = makeToolCall({ result: "hello world" });
    const msg = buildToolResultMessage(tc, TEST_TIMESTAMP);

    expect(msg.role).toBe("toolResult");
    expect(msg.content).toEqual([{ type: "text", text: "hello world" }]);
  });

  it("uses '(no result)' when result is undefined", () => {
    const tc = makeToolCall({ result: undefined });
    const msg = buildToolResultMessage(tc, TEST_TIMESTAMP);

    expect(msg.content).toEqual([{ type: "text", text: "(no result)" }]);
  });

  it("sets timestamp", () => {
    const tc = makeToolCall();
    const msg = buildToolResultMessage(tc, TEST_TIMESTAMP);
    expect(msg.timestamp).toBe(TEST_TIMESTAMP);
  });

  it("preserves large JSON results without double-encoding", () => {
    const largeJson = JSON.stringify([
      {
        id: "msg_1",
        from: "test@example.com",
        bodyText: "A long email body\nwith multiple lines\nand special chars: \u200c",
      },
    ]);
    const tc = makeToolCall({ result: largeJson });
    const msg = buildToolResultMessage(tc, TEST_TIMESTAMP);

    // The content text should be the raw JSON string
    const contentBlocks = msg.content as unknown[];
    expect((contentBlocks[0] as Record<string, unknown>).text).toBe(largeJson);
    // Not double-encoded
    expect((contentBlocks[0] as Record<string, unknown>).text).not.toContain('\\"id\\"');
  });
});

// ─── buildAssistantMessage ───────────────────────────────────────────────────

describe("buildAssistantMessage", () => {
  it("builds message with only text content", () => {
    const msg = buildAssistantMessage("Hello!", null, null, mockModel, TEST_TIMESTAMP);

    expect(msg.role).toBe("assistant");
    expect(msg.content).toEqual([{ type: "text", text: "Hello!" }]);
    expect(msg.stopReason).toBe("end_turn");
  });

  it("builds message with thinking + text", () => {
    const msg = buildAssistantMessage(
      "Here's the answer.",
      "Let me think about this...",
      null,
      mockModel,
      TEST_TIMESTAMP,
    );

    expect(msg.content).toEqual([
      { type: "thinking", thinking: "Let me think about this..." },
      { type: "text", text: "Here's the answer." },
    ]);
  });

  it("builds message with tool calls", () => {
    const toolCalls = [makeToolCall({ result: "result1" })];
    const msg = buildAssistantMessage(
      "Let me check that.",
      null,
      toolCalls,
      mockModel,
      TEST_TIMESTAMP,
    );

    expect(msg.content).toEqual([
      { type: "text", text: "Let me check that." },
      { type: "toolCall", id: "toolu_abc123", name: "mail_read", arguments: { ids: ["msg_1"] } },
    ]);
    expect(msg.stopReason).toBe("tool_use");
  });

  it("builds message with thinking + text + tool calls (canonical order)", () => {
    const toolCalls = [makeToolCall({ result: "result1" })];
    const msg = buildAssistantMessage(
      "Let me check that.",
      "I need to read the email first.",
      toolCalls,
      mockModel,
      TEST_TIMESTAMP,
    );

    // Canonical order: thinking → text → toolCall
    expect(msg.content).toEqual([
      { type: "thinking", thinking: "I need to read the email first." },
      { type: "text", text: "Let me check that." },
      { type: "toolCall", id: "toolu_abc123", name: "mail_read", arguments: { ids: ["msg_1"] } },
    ]);
  });

  it("builds message with only tool calls (no text)", () => {
    const toolCalls = [makeToolCall({ result: "result1" })];
    const msg = buildAssistantMessage(undefined, null, toolCalls, mockModel, TEST_TIMESTAMP);

    expect(msg.content).toEqual([
      { type: "toolCall", id: "toolu_abc123", name: "mail_read", arguments: { ids: ["msg_1"] } },
    ]);
    expect(msg.stopReason).toBe("tool_use");
  });

  it("builds message with only thinking (no text, no tools)", () => {
    const msg = buildAssistantMessage(undefined, "Thinking...", null, mockModel, TEST_TIMESTAMP);

    expect(msg.content).toEqual([{ type: "thinking", thinking: "Thinking..." }]);
    expect(msg.stopReason).toBe("end_turn");
  });

  it("uses resolved model metadata", () => {
    const msg = buildAssistantMessage("Hello", null, null, mockModel, TEST_TIMESTAMP);

    expect(msg.api).toBe("anthropic-messages");
    expect(msg.provider).toBe("anthropic");
    expect(msg.model).toBe("claude-sonnet-4-5-20250514");
  });

  it("handles undefined model gracefully", () => {
    const msg = buildAssistantMessage("Hello", null, null, undefined, TEST_TIMESTAMP);

    expect(msg.api).toBeUndefined();
    expect(msg.provider).toBeUndefined();
    expect(msg.model).toBeUndefined();
  });

  it("includes usage metadata", () => {
    const msg = buildAssistantMessage("Hello", null, null, mockModel, TEST_TIMESTAMP);

    expect(msg.usage).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: { total: 0 },
    });
  });

  it("handles multiple tool calls", () => {
    const toolCalls = [
      makeToolCall({ id: "tool_1", name: "mail_list" }),
      makeToolCall({ id: "tool_2", name: "mail_read" }),
    ];
    const msg = buildAssistantMessage(
      "Checking emails.",
      null,
      toolCalls,
      mockModel,
      TEST_TIMESTAMP,
    );

    const toolCallBlocks = (msg.content as unknown[]).filter(
      (c) =>
        typeof c === "object" &&
        c !== null &&
        "type" in c &&
        (c as Record<string, unknown>).type === "toolCall",
    );
    expect(toolCallBlocks).toHaveLength(2);
    expect((toolCallBlocks[0] as Record<string, unknown>).id).toBe("tool_1");
    expect((toolCallBlocks[1] as Record<string, unknown>).id).toBe("tool_2");
  });

  it("content block order is deterministic regardless of input", () => {
    // Even if we pass thinking, content, and toolCalls in any combination,
    // the output order should always be: thinking → text → toolCall
    const toolCalls = [makeToolCall()];

    const msg = buildAssistantMessage(
      "text content",
      "thinking content",
      toolCalls,
      mockModel,
      TEST_TIMESTAMP,
    );

    const types = (msg.content as unknown[]).map((c) =>
      typeof c === "object" && c !== null && "type" in c
        ? (c as Record<string, unknown>).type
        : undefined,
    );
    expect(types).toEqual(["thinking", "text", "toolCall"]);
  });
});

// ─── buildUserMessage ────────────────────────────────────────────────────────

describe("buildUserMessage", () => {
  it("wraps content in content array", () => {
    const msg = buildUserMessage("Hello there", TEST_TIMESTAMP);

    expect(msg.role).toBe("user");
    expect(msg.content).toEqual([{ type: "text", text: "Hello there" }]);
    expect(msg.timestamp).toBe(TEST_TIMESTAMP);
  });

  it("handles empty content", () => {
    const msg = buildUserMessage("", TEST_TIMESTAMP);
    expect(msg.content).toEqual([{ type: "text", text: "" }]);
  });
});

// ─── parseStoredToolCalls ────────────────────────────────────────────────────

describe("parseStoredToolCalls", () => {
  it("parses valid JSON array", () => {
    const json = JSON.stringify([makeToolCall()]);
    const result = parseStoredToolCalls(json);
    expect(result).toEqual([makeToolCall()]);
  });

  it("returns null for null input", () => {
    expect(parseStoredToolCalls(null)).toBeNull();
  });

  it("returns null for empty string", () => {
    // Empty string is falsy in JSON.parse context but we handle it
    expect(parseStoredToolCalls("")).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(parseStoredToolCalls("{invalid}")).toBeNull();
    expect(parseStoredToolCalls("not json at all")).toBeNull();
  });

  it("returns null for non-array JSON", () => {
    expect(parseStoredToolCalls(JSON.stringify({ foo: "bar" }))).toBeNull();
    expect(parseStoredToolCalls(JSON.stringify("string"))).toBeNull();
    expect(parseStoredToolCalls(JSON.stringify(42))).toBeNull();
  });

  it("parses empty array", () => {
    expect(parseStoredToolCalls(JSON.stringify([]))).toEqual([]);
  });
});

// ─── buildHistoryMessages ────────────────────────────────────────────────────

describe("buildHistoryMessages", () => {
  it("reconstructs a simple user → assistant conversation", () => {
    const stored: StoredMessage[] = [
      {
        role: "user",
        content: "What's the weather?",
        thinking: null,
        toolCalls: null,
      },
      {
        role: "assistant",
        content: "It's sunny today.",
        thinking: null,
        toolCalls: null,
      },
    ];

    const history = buildHistoryMessages(stored, toOptions(mockModel));

    // Should include all messages (no last-message exclusion since we passed all)
    // buildHistoryMessages excludes the last message (current prompt)
    expect(history).toHaveLength(1); // Only the user message (assistant is the "last" one)
    expect((history[0] as Record<string, unknown>).role).toBe("user");
  });

  it("excludes the last message (current user prompt)", () => {
    const stored: StoredMessage[] = [
      {
        role: "user",
        content: "First message",
        thinking: null,
        toolCalls: null,
      },
      {
        role: "assistant",
        content: "First response",
        thinking: null,
        toolCalls: null,
      },
      {
        role: "user",
        content: "Second message (current prompt)",
        thinking: null,
        toolCalls: null,
      },
    ];

    const history = buildHistoryMessages(stored, toOptions(mockModel));

    // Should have 2 messages (first user + first assistant), excluding last user
    expect(history).toHaveLength(2);
    const [firstUser, firstAssistant] = history as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(firstUser.role).toBe("user");
    const firstMsgContent = firstUser.content as unknown[];
    expect((firstMsgContent[0] as Record<string, unknown>).text).toBe("First message");
    expect(firstAssistant.role).toBe("assistant");
  });

  it("reconstructs assistant message with tool calls and tool results", () => {
    const toolCall = makeToolCall({ result: '{"email":"data"}' });
    const stored: StoredMessage[] = [
      {
        role: "user",
        content: "Read my email",
        thinking: null,
        toolCalls: null,
      },
      {
        role: "assistant",
        content: "Let me check.",
        thinking: "I'll use mail_read",
        toolCalls: JSON.stringify([toolCall]),
      },
      {
        role: "user",
        content: "Summarize it",
        thinking: null,
        toolCalls: null,
      },
    ];

    const history = buildHistoryMessages(stored, toOptions(mockModel));

    expect(history).toHaveLength(3);
    const [userMsg, assistantMsg, toolResultMsg] = history as [
      Record<string, unknown>,
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(userMsg.role).toBe("user");

    // Assistant message
    expect(assistantMsg.role).toBe("assistant");
    expect(assistantMsg.stopReason).toBe("tool_use");
    expect(assistantMsg.api).toBe("anthropic-messages");
    expect(assistantMsg.provider).toBe("anthropic");
    expect(assistantMsg.model).toBe("claude-sonnet-4-5-20250514");

    const assistantContent = assistantMsg.content as unknown[];
    expect((assistantContent[0] as Record<string, unknown>).type).toBe("thinking");
    expect((assistantContent[1] as Record<string, unknown>).type).toBe("text");
    expect((assistantContent[2] as Record<string, unknown>).type).toBe("toolCall");

    // Tool result message
    expect(toolResultMsg.role).toBe("toolResult");
    expect(toolResultMsg.toolCallId).toBe("toolu_abc123");
    expect(toolResultMsg.toolUseId).toBeUndefined();
    const toolResultContent = toolResultMsg.content as unknown[];
    expect((toolResultContent[0] as Record<string, unknown>).text).toBe('{"email":"data"}');
  });

  it("reconstructs multi-turn conversation with multiple tool calls", () => {
    const toolCalls1 = [
      makeToolCall({ id: "tool_1", name: "mail_list", result: "list result" }),
      makeToolCall({ id: "tool_2", name: "mail_read", result: "read result" }),
    ];
    const stored: StoredMessage[] = [
      {
        role: "user",
        content: "List and read emails",
        thinking: null,
        toolCalls: null,
      },
      {
        role: "assistant",
        content: "Here are your emails.",
        thinking: null,
        toolCalls: JSON.stringify(toolCalls1),
      },
      {
        role: "user",
        content: "Thanks, that's all",
        thinking: null,
        toolCalls: null,
      },
    ];

    const history = buildHistoryMessages(stored, toOptions(mockModel));

    // user → assistant → toolResult → toolResult (excluding last user)
    expect(history).toHaveLength(4);
    const [usr, asst, tr1, tr2] = history as [
      Record<string, unknown>,
      Record<string, unknown>,
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(usr.role).toBe("user");
    expect(asst.role).toBe("assistant");
    expect(tr1.role).toBe("toolResult");
    expect(tr2.role).toBe("toolResult");

    // Tool results should be in order
    expect(tr1.toolCallId).toBe("tool_1");
    expect(tr2.toolCallId).toBe("tool_2");
  });

  it("handles conversation with no model (undefined)", () => {
    const stored: StoredMessage[] = [
      {
        role: "user",
        content: "Hello",
        thinking: null,
        toolCalls: null,
      },
      {
        role: "assistant",
        content: "Hi!",
        thinking: null,
        toolCalls: null,
      },
    ];

    const history = buildHistoryMessages(stored, toOptions(undefined));
    const [userMsg] = history as [Record<string, unknown>];

    expect(userMsg.role).toBe("user");
    // When model is undefined, api/provider/model should be undefined
    expect(userMsg).not.toHaveProperty("api");
  });

  it("handles different model types (OpenAI-compatible)", () => {
    const stored: StoredMessage[] = [
      {
        role: "user",
        content: "Hello",
        thinking: null,
        toolCalls: null,
      },
      {
        role: "assistant",
        content: "Hi!",
        thinking: null,
        toolCalls: null,
      },
      {
        role: "user",
        content: "Next prompt",
        thinking: null,
        toolCalls: null,
      },
    ];

    const history = buildHistoryMessages(stored, toOptions(mockOpenAiModel));

    // Last message excluded, so history has user + assistant
    const assistantMsg = history[1] as Record<string, unknown>;
    expect(assistantMsg.api).toBe("openai-completions");
    expect(assistantMsg.provider).toBe("custom");
    expect(assistantMsg.model).toBe("gpt-4o");
  });

  it("handles malformed toolCalls JSON gracefully", () => {
    const stored: StoredMessage[] = [
      {
        role: "user",
        content: "Hello",
        thinking: null,
        toolCalls: null,
      },
      {
        role: "assistant",
        content: "Response",
        thinking: null,
        toolCalls: "{invalid json",
      },
      {
        role: "user",
        content: "Next",
        thinking: null,
        toolCalls: null,
      },
    ];

    const history = buildHistoryMessages(stored, toOptions(mockModel));

    // Should still work — malformed toolCalls treated as no tool calls
    expect(history).toHaveLength(2);
    const assistantMsg = history[1] as Record<string, unknown>;
    expect(assistantMsg.role).toBe("assistant");
    expect(assistantMsg.stopReason).toBe("end_turn"); // No tool calls
  });

  it("produces consistent output for same input (deterministic)", () => {
    const stored: StoredMessage[] = [
      {
        role: "user",
        content: "Hello",
        thinking: null,
        toolCalls: null,
      },
      {
        role: "assistant",
        content: "Hi there!",
        thinking: "Greeting the user",
        toolCalls: null,
      },
    ];

    const history1 = buildHistoryMessages(stored, toOptions(mockModel));
    const history2 = buildHistoryMessages(stored, toOptions(mockModel));

    // Structure should be identical (timestamps will differ but that's expected)
    expect(history1.map((m) => m.role)).toEqual(history2.map((m) => m.role));
    expect(history1.map((m) => m.content)).toEqual(history2.map((m) => m.content));
  });
});

// ─── Cache Identity Tests ────────────────────────────────────────────────────

describe("cache identity guarantees", () => {
  it("tool result text is identical between normalizeToolResult and buildToolResultMessage", () => {
    // Simulate the full round-trip:
    // 1. Tool returns { content: [{ type: "text", text: "..." }] }
    // 2. normalizeToolResult extracts the text
    // 3. buildToolResultMessage wraps it in [{ type: "text", text: extracted }]
    // 4. The result should match what the live agent sends to the LLM

    const toolOutput = JSON.stringify([
      {
        id: "msg_1",
        from: "test@example.com",
        bodyText: "Email body with special chars: \u200c\nand newlines",
      },
    ]);

    const toolResult = { content: [{ type: "text", text: toolOutput }] };

    // Step 2: normalize
    const normalized = normalizeToolResult(toolResult);

    // Step 3: build tool result message
    const tc = makeToolCall({ result: normalized });
    const msg = buildToolResultMessage(tc, TEST_TIMESTAMP);

    // The content text in the toolResult message should be the raw tool output
    const contentText = ((msg.content as unknown[])[0] as Record<string, unknown>).text;
    expect(contentText).toBe(toolOutput);

    // NOT double-encoded
    expect(contentText).not.toContain('\\"content\\"');
    expect(contentText).not.toContain('\\"type\\"');
    expect(contentText).not.toContain('\\"text\\"');
  });

  it("assistant message metadata matches resolved model exactly", () => {
    // The transformMessages function in pi-ai checks:
    // isSameModel = msg.provider === model.provider && msg.api === model.api && msg.model === model.id
    // If any of these don't match, thinking blocks are downgraded and cache misses occur.

    const msg = buildAssistantMessage("Response", "Thinking...", null, mockModel, TEST_TIMESTAMP);

    expect(msg.provider).toBe(mockModel.provider);
    expect(msg.api).toBe(mockModel.api);
    expect(msg.model).toBe(mockModel.id);
  });

  it("thinking blocks are preserved (not downgraded to text)", () => {
    // When isSameModel is true, thinking blocks stay as { type: "thinking" }.
    // When false, they become { type: "text", text: thinking }.
    // This test ensures our reconstruction produces thinking blocks.

    const msg = buildAssistantMessage(
      "Response",
      "Let me think...",
      null,
      mockModel,
      TEST_TIMESTAMP,
    );

    const content = msg.content as unknown[];
    const thinkingBlock = content.find(
      (c) =>
        typeof c === "object" &&
        c !== null &&
        "type" in c &&
        (c as Record<string, unknown>).type === "thinking",
    );
    expect(thinkingBlock).toBeDefined();
    expect((thinkingBlock as Record<string, unknown>).thinking).toBe("Let me think...");

    // No text block containing the thinking content
    const textBlocks = content.filter(
      (c) =>
        typeof c === "object" &&
        c !== null &&
        "type" in c &&
        (c as Record<string, unknown>).type === "text",
    );
    textBlocks.forEach((tb) => {
      expect((tb as Record<string, unknown>).text).not.toBe("Let me think...");
    });
  });

  it("toolCallId is used (not toolUseId) for all tool results", () => {
    // The Anthropic adapter maps msg.toolCallId → tool_use_id.
    // If toolUseId is used instead, the adapter reads undefined.

    const tc = makeToolCall({ result: "result" });
    const msg = buildToolResultMessage(tc, TEST_TIMESTAMP);

    // Must have toolCallId
    expect(msg.toolCallId).toBe(tc.id);
    // Must NOT have toolUseId
    expect(msg).not.toHaveProperty("toolUseId");
  });
});
