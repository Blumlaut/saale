import { describe, it, expect } from "vitest";
import {
  evaluatePromptGuard,
  evaluateReconnectAction,
  formatSseEvent,
  extractCumulativeText,
  extractThinking,
  extractToolCallIds,
  buildFinalAssistantMessage,
  type DbMessage,
} from "@/lib/pi/stream-logic";

describe("evaluatePromptGuard", () => {
  it("prompts when there is a new user message and no prior prompt", () => {
    const result = evaluatePromptGuard({ id: "msg-1", role: "user", content: "hello" }, null);
    expect(result.shouldPrompt).toBe(true);
    expect(result.reason).toBe("new user message");
  });

  it("prompts when lastPromptedMessageId differs from last message", () => {
    // E.g. user sent a follow-up after the first message was processed
    const result = evaluatePromptGuard(
      { id: "msg-2", role: "user", content: "follow up" },
      "msg-1",
    );
    expect(result.shouldPrompt).toBe(true);
  });

  it("skips prompting when the last message was already processed", () => {
    const result = evaluatePromptGuard({ id: "msg-1", role: "user", content: "hello" }, "msg-1");
    expect(result.shouldPrompt).toBe(false);
    expect(result.reason).toBe("already prompted");
  });

  it("skips prompting when the last message is an assistant reply", () => {
    // Conversation is idle — assistant has the last word
    const result = evaluatePromptGuard(
      { id: "msg-2", role: "assistant", content: "hi there" },
      "msg-1",
    );
    expect(result.shouldPrompt).toBe(false);
    expect(result.reason).toBe("no user message");
  });

  it("skips prompting when there are no messages", () => {
    const result = evaluatePromptGuard(undefined, null);
    expect(result.shouldPrompt).toBe(false);
    expect(result.reason).toBe("no user message");
  });

  it("skips prompting for toolResult as last message", () => {
    const result = evaluatePromptGuard({ id: "msg-3", role: "toolResult", content: "ok" }, "msg-1");
    expect(result.shouldPrompt).toBe(false);
  });

  it("skips prompting for custom messages", () => {
    const result = evaluatePromptGuard({ id: "msg-3", role: "custom", content: "info" }, "msg-1");
    expect(result.shouldPrompt).toBe(false);
  });
});

describe("evaluateReconnectAction", () => {
  it("emits done immediately when agent has finished", () => {
    const action = evaluateReconnectAction(false, "msg-1");
    expect(action.type).toBe("emit-done");
    expect(action.reason).toBe("agent-finished");
  });

  it("waits for events when agent is still streaming", () => {
    const action = evaluateReconnectAction(true, "msg-1");
    expect(action.type).toBe("wait-events");
    expect(action.reason).toBe("agent-streaming");
  });

  it("waits for events when no prior prompt was tracked", () => {
    // Edge case: pool entry exists but lastPromptedMessageId is null
    // (e.g. freshly created pool entry on reconnect after server restart)
    const action = evaluateReconnectAction(false, null);
    expect(action.type).toBe("wait-events");
    expect(action.reason).toBe("no-previous-prompt");
  });

  it("waits for events when streaming even without prior prompt", () => {
    const action = evaluateReconnectAction(true, null);
    expect(action.type).toBe("wait-events");
    expect(action.reason).toBe("no-previous-prompt");
  });
});

describe("formatSseEvent", () => {
  it("formats a simple event", () => {
    const output = formatSseEvent("done", {});
    expect(output).toBe("event: done\ndata: {}\n\n");
  });

  it("produces valid SSE for values with newlines", () => {
    const output = formatSseEvent("token", { text: "line1\nline2" });
    // JSON.stringify already escapes newlines as \n (two chars), so the output
    // is a single data line. Verify round-trip.
    const dataLine = output.match(/data: (.+)/);
    expect(dataLine).toBeTruthy();
    const parsed = JSON.parse(dataLine![1]!);
    expect(parsed.text).toBe("line1\nline2");
  });

  it("produces valid SSE for values with carriage returns", () => {
    const output = formatSseEvent("token", { text: "line1\r\nline2" });
    const dataLine = output.match(/data: (.+)/);
    expect(dataLine).toBeTruthy();
    const parsed = JSON.parse(dataLine![1]!);
    expect(parsed.text).toBe("line1\r\nline2");
  });

  it("handles nested objects with newlines", () => {
    const output = formatSseEvent("tool_end", {
      toolName: "search",
      result: "found:\n- item1\n- item2",
    });
    expect(output).toMatch(/^event: tool_end\ndata: .+\n\n$/);
    // Should be a single data line (newlines escaped)
    const dataLine = output.match(/data: (.+)/);
    expect(dataLine).toBeTruthy();
    // The JSON should contain escaped newlines, not literal ones
    const jsonData = dataLine![1]!;
    expect(JSON.parse(jsonData)).toEqual({
      toolName: "search",
      result: "found:\n- item1\n- item2",
    });
  });

  it("handles null data", () => {
    const output = formatSseEvent("ping", null);
    expect(output).toBe("event: ping\ndata: null\n\n");
  });

  it("handles arrays", () => {
    const output = formatSseEvent("list", [1, 2, 3]);
    expect(output).toBe("event: list\ndata: [1,2,3]\n\n");
  });
});

describe("extractCumulativeText", () => {
  it("extracts text from a single text block", () => {
    const content = [{ type: "text", text: "hello world" }];
    expect(extractCumulativeText(content)).toBe("hello world");
  });

  it("joins multiple text blocks", () => {
    const content = [
      { type: "text", text: "first " },
      { type: "text", text: "second" },
    ];
    expect(extractCumulativeText(content)).toBe("first second");
  });

  it("ignores non-text blocks", () => {
    const content = [
      { type: "text", text: "hello" },
      { type: "thinking", thinking: "let me think" },
      { type: "toolCall", id: "tc-1", name: "search" },
    ];
    expect(extractCumulativeText(content)).toBe("hello");
  });

  it("handles empty content array", () => {
    expect(extractCumulativeText([])).toBe("");
  });

  it("handles missing text field", () => {
    const content = [{ type: "text" }];
    expect(extractCumulativeText(content)).toBe("");
  });

  it("handles null text field", () => {
    const content = [{ type: "text", text: null }];
    expect(extractCumulativeText(content)).toBe("");
  });

  it("handles non-object entries in content", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const content = ["string", 42, null, { type: "text", text: "valid" }] as any;
    expect(extractCumulativeText(content)).toBe("valid");
  });
});

describe("extractThinking", () => {
  it("extracts thinking from a thinking block", () => {
    const content = [{ type: "thinking", thinking: "reasoning here" }];
    expect(extractThinking(content)).toBe("reasoning here");
  });

  it("returns null when no thinking block exists", () => {
    const content = [{ type: "text", text: "hello" }];
    expect(extractThinking(content)).toBe(null);
  });

  it("returns null for empty content", () => {
    expect(extractThinking([])).toBe(null);
  });

  it("returns null when thinking field is missing", () => {
    const content = [{ type: "thinking" }];
    expect(extractThinking(content)).toBe(null);
  });

  it("returns null when thinking is empty string", () => {
    const content = [{ type: "thinking", thinking: "" }];
    expect(extractThinking(content)).toBe(null);
  });

  it("finds thinking block among other content", () => {
    const content = [
      { type: "text", text: "partial" },
      { type: "thinking", thinking: "deep thought" },
      { type: "toolCall", id: "tc-1" },
    ];
    expect(extractThinking(content)).toBe("deep thought");
  });
});

describe("extractToolCallIds", () => {
  it("extracts IDs from tool call blocks", () => {
    const content = [
      { type: "toolCall", id: "tc-1", name: "search" },
      { type: "toolCall", id: "tc-2", name: "read" },
    ];
    expect(extractToolCallIds(content)).toEqual(["tc-1", "tc-2"]);
  });

  it("ignores non-tool-call blocks", () => {
    const content = [
      { type: "text", text: "hello" },
      { type: "toolCall", id: "tc-1", name: "search" },
    ];
    expect(extractToolCallIds(content)).toEqual(["tc-1"]);
  });

  it("returns empty array when no tool calls", () => {
    expect(extractToolCallIds([])).toEqual([]);
  });
});

describe("buildFinalAssistantMessage", () => {
  it("builds a complete message with text, thinking, and tool calls", () => {
    const content = [
      { type: "text", text: "The answer is 42." },
      { type: "thinking", thinking: "Let me calculate..." },
      { type: "toolCall", id: "tc-1", name: "calculator", arguments: { expr: "6*7" } },
    ];
    const toolResults = new Map([
      ["tc-1", { name: "calculator", args: { expr: "6*7" }, result: "42" }],
    ]);

    const result = buildFinalAssistantMessage(content, toolResults);

    expect(result.text).toBe("The answer is 42.");
    expect(result.thinking).toBe("Let me calculate...");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toEqual({
      id: "tc-1",
      name: "calculator",
      args: { expr: "6*7" },
      result: "42",
      isError: undefined,
    });
  });

  it("handles missing tool results", () => {
    const content = [{ type: "toolCall", id: "tc-1", name: "search", arguments: { q: "test" } }];
    const toolResults = new Map(); // no results yet

    const result = buildFinalAssistantMessage(content, toolResults);

    expect(result.toolCalls[0]!.result).toBeUndefined();
    expect(result.toolCalls[0]!.isError).toBeUndefined();
  });

  it("handles tool errors", () => {
    const content = [{ type: "toolCall", id: "tc-1", name: "search", arguments: { q: "test" } }];
    const toolResults = new Map([
      [
        "tc-1",
        {
          name: "search",
          args: { q: "test" },
          result: "not found",
          isError: true,
        },
      ],
    ]);

    const result = buildFinalAssistantMessage(content, toolResults);

    expect(result.toolCalls[0]!.isError).toBe(true);
  });

  it("handles text-only response (no tools, no thinking)", () => {
    const content = [{ type: "text", text: "Simple answer." }];
    const result = buildFinalAssistantMessage(content, new Map());

    expect(result.text).toBe("Simple answer.");
    expect(result.thinking).toBe(null);
    expect(result.toolCalls).toEqual([]);
  });

  it("handles multiple text blocks", () => {
    const content = [
      { type: "text", text: "Part 1. " },
      { type: "text", text: "Part 2." },
    ];
    const result = buildFinalAssistantMessage(content, new Map());

    expect(result.text).toBe("Part 1. Part 2.");
  });
});

// ── Integration-style scenarios ──────────────────────────────────────

describe("chat stream scenarios", () => {
  describe("initial message flow", () => {
    it("prompts on first user message, then streams response", () => {
      // User sends first message
      const userMsg: DbMessage = { id: "msg-1", role: "user", content: "hello" };
      const guard = evaluatePromptGuard(userMsg, null);
      expect(guard.shouldPrompt).toBe(true);

      // After prompt is sent, lastPromptedMessageId is set
      // On reconnect, should not re-prompt
      const guardAfter = evaluatePromptGuard(userMsg, "msg-1");
      expect(guardAfter.shouldPrompt).toBe(false);

      // If agent finished, reconnect should emit done
      const reconnectAction = evaluateReconnectAction(false, "msg-1");
      expect(reconnectAction.type).toBe("emit-done");
    });
  });

  describe("user navigates away during processing", () => {
    it("reconnect while agent is streaming waits for events", () => {
      // Agent has been prompted
      const guard = evaluatePromptGuard({ id: "msg-1", role: "user", content: "hello" }, "msg-1");
      expect(guard.shouldPrompt).toBe(false);

      // Agent is still streaming
      const action = evaluateReconnectAction(true, "msg-1");
      expect(action.type).toBe("wait-events");
      expect(action.reason).toBe("agent-streaming");
    });

    it("reconnect after agent finishes emits done immediately", () => {
      // Agent has finished
      const action = evaluateReconnectAction(false, "msg-1");
      expect(action.type).toBe("emit-done");
    });
  });

  describe("multiple rapid reconnects", () => {
    it("each reconnect sees the same prompt guard state", () => {
      // First reconnect (agent still streaming)
      const action1 = evaluateReconnectAction(true, "msg-1");
      expect(action1.type).toBe("wait-events");

      // Second reconnect (agent still streaming)
      const action2 = evaluateReconnectAction(true, "msg-1");
      expect(action2.type).toBe("wait-events");

      // Third reconnect (agent finished)
      const action3 = evaluateReconnectAction(false, "msg-1");
      expect(action3.type).toBe("emit-done");
    });
  });

  describe("conversation with follow-up messages", () => {
    it("prompts follow-up when lastPromptedMessageId lags behind", () => {
      // First message was processed
      const firstMsg: DbMessage = { id: "msg-1", role: "user", content: "hello" };
      expect(evaluatePromptGuard(firstMsg, "msg-1").shouldPrompt).toBe(false);

      // User sends follow-up (now last message is msg-2)
      const followUp: DbMessage = { id: "msg-2", role: "user", content: "and what about..." };
      expect(evaluatePromptGuard(followUp, "msg-1").shouldPrompt).toBe(true);
    });

    it("does not re-prompt follow-up after it was processed", () => {
      const followUp: DbMessage = { id: "msg-2", role: "user", content: "and what about..." };
      expect(evaluatePromptGuard(followUp, "msg-2").shouldPrompt).toBe(false);
    });
  });

  describe("SSE event escaping prevents injection", () => {
    it("tool results with newlines do not break SSE format", () => {
      // A tool result containing newlines (common in search results, file contents)
      const event = formatSseEvent("tool_end", {
        toolCallId: "tc-1",
        toolName: "file_read",
        result: "line1\nline2\nline3",
      });

      // The output should be exactly 3 lines: event:, data:, and blank terminator
      const lines = event.split("\n");
      expect(lines).toHaveLength(4); // ["event: ...", "data: ...", "", ""]
      expect(lines[0]).toBe("event: tool_end");
      expect(lines[1]).toMatch(/^data: /);

      // Parsing the data should give back the original newlines
      const data = JSON.parse(lines[1]!.slice("data: ".length));
      expect(data.result).toBe("line1\nline2\nline3");
    });

    it("assistant text with newlines does not break SSE format", () => {
      const event = formatSseEvent("token", {
        text: "Here's a list:\n- item 1\n- item 2\n- item 3",
      });

      const lines = event.split("\n");
      expect(lines).toHaveLength(4);
      const data = JSON.parse(lines[1]!.slice("data: ".length));
      expect(data.text).toBe("Here's a list:\n- item 1\n- item 2\n- item 3");
    });
  });
});
