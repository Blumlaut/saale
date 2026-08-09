import { describe, it, expect } from "vitest";
import { streamReducer, type StreamState } from "@/lib/chat/stream-reducer";
import type { Message } from "@/components/chat/types";

function state(messages: Message[] = [], rootMessageId: string | null = null): StreamState {
  return { messages, rootMessageId };
}

function msg(overrides: Partial<Message> & { id: string }): Message {
  return {
    role: "assistant",
    content: "",
    thinking: undefined,
    toolCalls: undefined,
    parentMessageId: undefined,
    createdAt: "2026-01-01T00:00:00.000Z",
    attachments: undefined,
    ...overrides,
  };
}

const empty = state();

describe("streamReducer", () => {
  it("turn_start creates a streaming message", () => {
    const next = streamReducer(empty, { type: "turn_start", turnId: "t1" });
    expect(next.messages).toHaveLength(1);
    expect(next.messages[0]).toMatchObject({
      id: "streaming-t1",
      role: "assistant",
      content: "",
    });
  });

  it("token without a preceding turn_start creates the message (buffer replay)", () => {
    const next = streamReducer(empty, { type: "token", turnId: "t1", text: "hello" });
    expect(next.messages).toHaveLength(1);
    expect(next.messages[0]!.content).toBe("hello");
  });

  it("token updates the existing streaming message with cumulative text", () => {
    let s = streamReducer(empty, { type: "turn_start", turnId: "t1" });
    s = streamReducer(s, { type: "token", turnId: "t1", text: "hel" });
    s = streamReducer(s, { type: "token", turnId: "t1", text: "hello" });
    expect(s.messages[0]!.content).toBe("hello");
    expect(s.messages).toHaveLength(1);
  });

  it("thinking sets the thinking block (empty string is dropped)", () => {
    let s = streamReducer(empty, { type: "turn_start", turnId: "t1" });
    s = streamReducer(s, { type: "thinking", turnId: "t1", thinking: "hmm" });
    expect(s.messages[0]!.thinking).toBe("hmm");
    s = streamReducer(s, { type: "thinking", turnId: "t1", thinking: "" });
    expect(s.messages[0]!.thinking).toBeUndefined();
  });

  it("tool_start adds a running tool call and dedupes re-delivered calls", () => {
    const action = {
      type: "tool_start" as const,
      turnId: "t1",
      toolCallId: "call-1",
      toolName: "web_search",
      args: { query: "x" },
    };
    let s = streamReducer(empty, { type: "turn_start", turnId: "t1" });
    s = streamReducer(s, action);
    expect(s.messages[0]!.toolCalls).toEqual([
      { id: "call-1", name: "web_search", args: { query: "x" }, status: "running" },
    ]);
    // Re-delivery (reconnect replay) must not duplicate.
    const again = streamReducer(s, action);
    expect(again.messages[0]!.toolCalls).toHaveLength(1);
  });

  it("tool_start without a turn message creates one seeded with the tool call", () => {
    const next = streamReducer(empty, {
      type: "tool_start",
      turnId: "t1",
      toolCallId: "call-1",
      toolName: "bash",
      args: { command: "ls" },
    });
    expect(next.messages).toHaveLength(1);
    expect(next.messages[0]!.toolCalls).toHaveLength(1);
  });

  it("tool_update streams partial output into a running tool call", () => {
    let s = streamReducer(empty, {
      type: "tool_start",
      turnId: "t1",
      toolCallId: "call-1",
      toolName: "bash",
      args: {},
    });
    s = streamReducer(s, {
      type: "tool_update",
      turnId: "t1",
      toolCallId: "call-1",
      partialResult: "out",
    });
    expect(s.messages[0]!.toolCalls![0]!.result).toBe("out");
  });

  it("tool_end marks the call completed with its result", () => {
    let s = streamReducer(empty, {
      type: "tool_start",
      turnId: "t1",
      toolCallId: "call-1",
      toolName: "bash",
      args: {},
    });
    s = streamReducer(s, { type: "tool_end", turnId: "t1", toolCallId: "call-1", result: "done" });
    const tc = s.messages[0]!.toolCalls![0]!;
    expect(tc.status).toBe("completed");
    expect(tc.result).toBe("done");
    expect(tc.error).toBeUndefined();
  });

  it("tool_end with isError marks the call as error", () => {
    let s = streamReducer(empty, {
      type: "tool_start",
      turnId: "t1",
      toolCallId: "call-1",
      toolName: "bash",
      args: {},
    });
    s = streamReducer(s, {
      type: "tool_end",
      turnId: "t1",
      toolCallId: "call-1",
      result: "boom",
      isError: true,
    });
    const tc = s.messages[0]!.toolCalls![0]!;
    expect(tc.status).toBe("error");
    expect(tc.error).toBe("boom");
  });

  it("turn_end finalizes content and thinking (safety net for the final token)", () => {
    let s = streamReducer(empty, { type: "turn_start", turnId: "t1" });
    s = streamReducer(s, { type: "turn_end", turnId: "t1", text: "final", thinking: "thought" });
    expect(s.messages[0]!.content).toBe("final");
    expect(s.messages[0]!.thinking).toBe("thought");
  });

  it("message_saved swaps the streaming ID for the real DB ID", () => {
    let s = streamReducer(empty, { type: "turn_start", turnId: "t1" });
    s = streamReducer(s, { type: "message_saved", turnId: "t1", messageId: "msg-1" });
    expect(s.messages[0]!.id).toBe("msg-1");
    expect(s.rootMessageId).toBe("msg-1");
  });

  it("first saved message becomes the root; later turns inherit it as parent", () => {
    let s = streamReducer(empty, { type: "turn_start", turnId: "t1" });
    s = streamReducer(s, { type: "message_saved", turnId: "t1", messageId: "root-1" });
    // Child turn of the same generation streams in.
    s = streamReducer(s, { type: "turn_start", turnId: "t2" });
    expect(s.messages[1]!.parentMessageId).toBe("root-1");
    // A second message_saved must NOT change the root.
    s = streamReducer(s, { type: "message_saved", turnId: "t2", messageId: "child-2" });
    expect(s.rootMessageId).toBe("root-1");
  });

  it("generation_done drops streaming messages but keeps saved ones", () => {
    let s = streamReducer(empty, { type: "turn_start", turnId: "t1" });
    s = streamReducer(s, { type: "message_saved", turnId: "t1", messageId: "saved-1" });
    s = streamReducer(s, { type: "turn_start", turnId: "t2" });
    s = streamReducer(s, { type: "generation_done" });
    expect(s.messages.map((m) => m.id)).toEqual(["saved-1"]);
  });

  it("leaves unrelated messages untouched", () => {
    const base = state([msg({ id: "saved-user", role: "user", content: "hi" })]);
    const next = streamReducer(base, { type: "turn_start", turnId: "t1" });
    expect(next.messages).toHaveLength(2);
    expect(next.messages[0]).toBe(base.messages[0]);
  });
});
