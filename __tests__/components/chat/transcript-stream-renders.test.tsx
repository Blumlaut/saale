// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render } from "@testing-library/react";
import { MessageList } from "@/components/chat/message-list";
import type { Message, ToolCallData } from "@/components/chat/types";

/**
 * What a stream event costs. A token replaces one message object and rebuilds
 * every render group around it, so without the memoization on the group and on
 * `ToolCallGroup`, every settled turn re-splits its calls and re-renders for
 * every frame of a reply.
 *
 * `splitToolCalls` stands in for that work: it runs once per rendered turn, and
 * the cards themselves are already memoized per call.
 */

const counters = { split: 0 };

vi.mock("@/components/chat/tool-cards", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/chat/tool-cards")>();
  return {
    ...actual,
    splitToolCalls: (calls: readonly ToolCallData[]) => {
      counters.split++;
      return actual.splitToolCalls(calls);
    },
  };
});

beforeAll(() => {
  // jsdom has no layout, so scrollIntoView does not exist.
  Element.prototype.scrollIntoView = vi.fn();
});

beforeEach(() => {
  counters.split = 0;
});

function toolCall(index: number): ToolCallData {
  return {
    id: `tc${index}`,
    name: "bash",
    args: { command: `step ${index}` },
    status: "completed",
    result: "ok",
    error: undefined,
  };
}

function step(index: number, parentMessageId: string, content = ""): Message {
  return {
    id: `s${index}`,
    role: "assistant",
    content,
    thinking: undefined,
    toolCalls: [toolCall(index)],
    parentMessageId,
    createdAt: "2026-01-01T12:00:00.000Z",
    attachments: undefined,
  };
}

/** Four turns, each a run of three steps, the last one still streaming. */
function transcript(): Message[] {
  const messages: Message[] = [];
  for (let turn = 0; turn < 4; turn++) {
    messages.push({
      id: `u${turn}`,
      role: "user",
      content: `question ${turn}`,
      thinking: undefined,
      toolCalls: undefined,
      parentMessageId: undefined,
      createdAt: "2026-01-01T12:00:00.000Z",
      attachments: undefined,
    });
    for (let i = 0; i < 3; i++) messages.push(step(turn * 10 + i, `u${turn}`));
    messages.push(step(turn * 10 + 9, `u${turn}`, `answer ${turn}`));
  }
  return messages;
}

describe("transcript work per stream event", () => {
  it("reads a token's turn without re-splitting any turn's calls", () => {
    const messages = transcript();
    const { rerender } = render(<MessageList messages={messages} isLoading />);
    const afterMount = counters.split;
    // One split per step that carries a call.
    expect(afterMount).toBe(messages.filter((message) => message.toolCalls?.length).length);

    // A token lands on the last message: a new object, same tool calls.
    rerender(
      <MessageList
        messages={messages.map((message, index) =>
          index === messages.length - 1 ? { ...message, content: "answer 3 (more)" } : message,
        )}
        isLoading
      />,
    );

    // Its prose changed, its calls did not: no turn's calls are read again.
    expect(counters.split - afterMount).toBe(0);
  });

  it("leaves the transcript alone when it re-renders for another reason", () => {
    const messages = transcript();
    const { rerender } = render(<MessageList messages={messages} />);
    const afterMount = counters.split;

    // Same messages, new array identity: what a parent re-render looks like.
    rerender(<MessageList messages={[...messages]} />);

    expect(counters.split).toBe(afterMount);
  });
});
