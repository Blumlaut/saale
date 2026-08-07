import { describe, it, expect } from "vitest";
import {
  decideStreamAction,
  formatSseEvent,
  extractCumulativeText,
  extractThinking,
  extractToolCallIds,
  buildFinalAssistantMessage,
  type DbMessage,
} from "@/lib/pi/stream-logic";

describe("decideStreamAction", () => {
  const userMsg: DbMessage = { id: "msg-1", role: "user", content: "hello" };
  const assistantMsg: DbMessage = { id: "msg-2", role: "assistant", content: "hi" };

  const base = {
    hasAssistantAfterLastUser: false,
    isGenerating: false,
    generationStartedAt: null,
    poolLastPromptedMessageId: null,
    pendingPromptMessageId: null,
    bufferHasDone: false,
    bufferHasEvents: false,
  };

  describe("pending user message", () => {
    it("prompts when a fresh user message has no response yet", () => {
      const action = decideStreamAction({ ...base, lastMessage: userMsg });
      expect(action.type).toBe("prompt");
      expect(action.reason).toBe("unanswered user message");
    });

    it("prompts when the message POST claimed the prompt", () => {
      const action = decideStreamAction({
        ...base,
        lastMessage: userMsg,
        pendingPromptMessageId: "msg-1",
      });
      expect(action.type).toBe("prompt");
      expect(action.reason).toBe("prompt claimed by message POST");
    });

    it("observes when this process already prompted the message", () => {
      const action = decideStreamAction({
        ...base,
        lastMessage: userMsg,
        poolLastPromptedMessageId: "msg-1",
      });
      expect(action.type).toBe("observe");
      expect(action.reason).toBe("already prompted in this process");
    });

    it("observes when a generation is active elsewhere (e.g. worker)", () => {
      const action = decideStreamAction({
        ...base,
        lastMessage: userMsg,
        isGenerating: true,
        generationStartedAt: Date.now(),
      });
      expect(action.type).toBe("observe");
      expect(action.reason).toBe("generation in progress");
    });

    it("reports done when the message already has a response", () => {
      const action = decideStreamAction({
        ...base,
        lastMessage: userMsg,
        hasAssistantAfterLastUser: true,
      });
      expect(action.type).toBe("done");
      expect(action.reason).toBe("last user message already answered");
    });

    it("reports done when the message already has a response (even if buffered)", () => {
      const action = decideStreamAction({
        ...base,
        lastMessage: userMsg,
        hasAssistantAfterLastUser: true,
        bufferHasDone: true,
      });
      expect(action.type).toBe("done");
    });

    it("observes when only a buffered done exists (replay delivers it)", () => {
      const action = decideStreamAction({
        ...base,
        lastMessage: userMsg,
        bufferHasDone: true,
      });
      expect(action.type).toBe("observe");
    });

    it("prompts to take over a stale generation (registered but silent)", () => {
      const action = decideStreamAction({
        ...base,
        lastMessage: userMsg,
        isGenerating: true,
        generationStartedAt: Date.now() - 120_000, // older than the 90s grace
        bufferHasEvents: false,
      });
      expect(action.type).toBe("prompt");
    });

    it("observes a slow generation that is still within the grace period", () => {
      const action = decideStreamAction({
        ...base,
        lastMessage: userMsg,
        isGenerating: true,
        generationStartedAt: Date.now() - 10_000,
        bufferHasEvents: false,
      });
      expect(action.type).toBe("observe");
    });

    it("does not take over a stale generation that produced events", () => {
      const action = decideStreamAction({
        ...base,
        lastMessage: userMsg,
        isGenerating: true,
        generationStartedAt: Date.now() - 120_000,
        bufferHasEvents: true,
      });
      expect(action.type).toBe("observe");
    });
  });

  describe("no pending user message", () => {
    it("reports done for an empty chat", () => {
      const action = decideStreamAction({ ...base, lastMessage: undefined });
      expect(action.type).toBe("done");
      expect(action.reason).toBe("idle conversation");
    });

    it("reports done for an idle conversation ending with an assistant message", () => {
      const action = decideStreamAction({ ...base, lastMessage: assistantMsg });
      expect(action.type).toBe("done");
    });

    it("observes a multi-turn run mid-generation (assistant message saved)", () => {
      const action = decideStreamAction({
        ...base,
        lastMessage: assistantMsg,
        isGenerating: true,
        generationStartedAt: Date.now(),
      });
      expect(action.type).toBe("observe");
    });
  });
});

describe("formatSseEvent", () => {
  it("formats a simple event", () => {
    const output = formatSseEvent("done", {});
    expect(output).toBe("event: done\ndata: {}\n\n");
  });

  it("produces valid SSE for values with newlines", () => {
    const output = formatSseEvent("token", { text: "line1\nline2" });
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

  it("handles null data", () => {
    const output = formatSseEvent("ping", null);
    expect(output).toBe("event: ping\ndata: null\n\n");
  });

  it("handles arrays", () => {
    const output = formatSseEvent("list", [1, 2, 3]);
    expect(output).toBe("event: list\ndata: [1,2,3]\n\n");
  });

  it("prepends the id line when an id is given", () => {
    expect(formatSseEvent("token", { text: "x" }, 42)).toBe(
      'id: 42\nevent: token\ndata: {"text":"x"}\n\n',
    );
  });

  it("omits the id line when no id is given (unbuffered events)", () => {
    expect(formatSseEvent("done", {})).not.toContain("id:");
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
    const toolResults = new Map();

    const result = buildFinalAssistantMessage(content, toolResults);

    expect(result.toolCalls[0]!.result).toBeUndefined();
    expect(result.toolCalls[0]!.isError).toBeUndefined();
  });

  it("handles tool errors", () => {
    const content = [{ type: "toolCall", id: "tc-1", name: "search", arguments: { q: "test" } }];
    const toolResults = new Map([
      ["tc-1", { name: "search", args: { q: "test" }, result: "not found", isError: true }],
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
});
