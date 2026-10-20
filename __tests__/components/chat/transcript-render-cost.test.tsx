// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, fireEvent } from "@testing-library/react";
import { useCallback, useState } from "react";
import type { ReactNode } from "react";
import { MessageList } from "@/components/chat/message-list";
import { InputBar } from "@/components/chat/input-bar";
import type { Message } from "@/components/chat/types";

/**
 * Keystroke cost. The composer draft lives in ChatInterface, so every
 * character typed re-renders the parent  which must not re-render (or re-parse
 * the markdown of) the transcript below it. The markdown-render counts below
 * cover the per-message memoization; the memo-identity check covers the list
 * itself, whose bailout a Profiler cannot observe.
 */

const counters = { markdown: 0 };

vi.mock("react-markdown", () => ({
  default: ({ children }: { children: ReactNode }) => {
    counters.markdown++;
    return <div>{children}</div>;
  },
}));

beforeAll(() => {
  // jsdom has no layout, so scrollIntoView does not exist.
  Element.prototype.scrollIntoView = vi.fn();
});

beforeEach(() => {
  counters.markdown = 0;
});

function message(overrides: Partial<Message> & { id: string }): Message {
  return {
    role: "user",
    content: "",
    thinking: undefined,
    toolCalls: undefined,
    parentMessageId: undefined,
    createdAt: "2026-01-01T12:00:00.000Z",
    attachments: undefined,
    ...overrides,
  };
}

function transcript(turns: number): Message[] {
  const messages: Message[] = [];
  for (let i = 0; i < turns; i++) {
    messages.push(
      message({ id: `u${i}`, role: "user", content: `question ${i}` }),
      message({ id: `a${i}`, role: "assistant", content: `## answer ${i}` }),
    );
  }
  return messages;
}

/**
 * Mirrors ChatInterface: the draft state that drives the composer lives in the
 * parent of the transcript, and the list's callbacks are stable.
 */
function Harness({ messages }: { messages: Message[] }) {
  const [draft, setDraft] = useState("");
  const [pendingApprovals] = useState<never[]>([]);
  const onEdit = useCallback(async () => {}, []);
  const onSend = useCallback(() => {}, []);
  const onApprovalResolved = useCallback(() => {}, []);

  return (
    <>
      <MessageList
        messages={messages}
        isLoading={false}
        onEditMessage={onEdit}
        onSendMessage={onSend}
        pendingApprovals={pendingApprovals}
        onApprovalResolved={onApprovalResolved}
        sessionId="session-1"
        activeTool={null}
        retry={null}
      />
      <InputBar
        onSend={onSend}
        value={draft}
        onValueChange={setDraft}
        isLoading={false}
        onStop={() => {}}
      />
    </>
  );
}

describe("transcript render cost", () => {
  it("does not re-render the transcript while typing in the composer", () => {
    const { container } = render(<Harness messages={transcript(8)} />);
    const afterMount = counters.markdown;
    expect(afterMount).toBe(8);

    const textarea = container.querySelector("textarea")!;
    for (const ch of "the quick brown fox jumps over the lazy dog") {
      fireEvent.change(textarea, { target: { value: textarea.value + ch } });
    }

    // 43 keystrokes, zero extra markdown renders.
    expect(counters.markdown).toBe(afterMount);
  });

  it("re-renders only the streaming message when a token arrives", () => {
    const messages = transcript(8);
    const { rerender } = render(<Harness messages={messages} />);
    const afterMount = counters.markdown;
    expect(afterMount).toBe(8);

    // A token arrives on the last turn: only that bubble is re-parsed.
    rerender(
      <Harness
        messages={messages.map((m, i) =>
          i === messages.length - 1 ? { ...m, content: "## answer 7 (more)" } : m,
        )}
      />,
    );

    expect(counters.markdown).toBe(afterMount + 1);
  });

  it("keeps the transcript list itself memoized", () => {
    // memo() is what makes typing independent of the transcript length: an
    // unmemoized list re-reconciles every group wrapper on each keystroke
    // (~5-10ms on a long transcript, against ~1ms with the memo in place).
    const memoType = (MessageList as unknown as { $$typeof: symbol }).$$typeof;
    expect(memoType).toBe(Symbol.for("react.memo"));
  });

  it("keeps bubbles that did not change from being re-parsed", () => {
    const { rerender } = render(<Harness messages={transcript(8)} />);
    expect(counters.markdown).toBe(8);

    // Rebuilt message objects with identical content: no re-parse.
    rerender(<Harness messages={transcript(8)} />);
    expect(counters.markdown).toBe(8);

    // Every assistant bubble changed: all of them are re-parsed.
    rerender(<Harness messages={transcript(8).map((m) => ({ ...m, content: `${m.content}!` }))} />);
    expect(counters.markdown).toBe(16);
  });
});
