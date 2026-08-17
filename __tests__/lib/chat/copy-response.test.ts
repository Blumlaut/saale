import { describe, it, expect } from "vitest";
import { getAssistantCopyText } from "@/lib/chat/copy-response";
import type { Message } from "@/components/chat/types";

function makeAssistantMessage(overrides: Partial<Message>): Message {
  return {
    id: "m-1",
    role: "assistant",
    content: "",
    thinking: undefined,
    toolCalls: undefined,
    parentMessageId: undefined,
    createdAt: new Date().toISOString(),
    attachments: undefined,
    ...overrides,
  };
}

describe("getAssistantCopyText", () => {
  it("joins multi-turn response content with a blank line (happy path)", () => {
    const text = getAssistantCopyText([
      makeAssistantMessage({ id: "1", content: "Let me check that." }),
      makeAssistantMessage({
        id: "2",
        content: "Here's the answer.",
        thinking: "internal reasoning that should not be copied",
      }),
    ]);
    expect(text).toBe("Let me check that.\n\nHere's the answer.");
  });

  it("skips turns that only have thinking or tool calls", () => {
    const text = getAssistantCopyText([
      makeAssistantMessage({ id: "1", thinking: "only thinking" }),
      makeAssistantMessage({
        id: "2",
        toolCalls: [
          {
            id: "tc-1",
            name: "web_search",
            args: {},
            status: "completed",
            result: "some result",
            error: undefined,
          },
        ],
      }),
      makeAssistantMessage({ id: "3", content: "Final answer" }),
    ]);
    expect(text).toBe("Final answer");
  });

  it("returns an empty string when no turn has copyable text", () => {
    const text = getAssistantCopyText([
      makeAssistantMessage({ id: "1", content: "   " }),
      makeAssistantMessage({ id: "2", content: "" }),
      makeAssistantMessage({ id: "3" }),
    ]);
    expect(text).toBe("");
  });
});
