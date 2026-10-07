// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MessageList } from "@/components/chat/message-list";
import type { Message } from "@/components/chat/types";

/**
 * The render window. A long transcript is thousands of DOM nodes, so only the
 * tail is rendered and earlier turns are revealed on demand. These tests pin
 * down which turns are in the DOM, the reveal control, and the promise that a
 * revealed turn is never pulled back out from under a reader.
 */

beforeAll(() => {
  // jsdom has no layout, so scrollIntoView does not exist.
  Element.prototype.scrollIntoView = vi.fn();
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

/** `turns` user/assistant pairs — two renderable groups per turn. */
function transcript(turns: number): Message[] {
  const messages: Message[] = [];
  for (let i = 0; i < turns; i++) {
    messages.push(
      message({ id: `u${i}`, role: "user", content: `question ${i}` }),
      message({ id: `a${i}`, role: "assistant", content: `answer ${i}` }),
    );
  }
  return messages;
}

function revealButton() {
  return screen.queryByRole("button", { name: /earlier messages?$/ });
}

describe("MessageList render window", () => {
  it("renders only the tail of a long transcript, with the count to reveal", () => {
    render(<MessageList messages={transcript(60)} />);

    // Newest turn is on screen, oldest is not.
    expect(screen.getByText("answer 59")).toBeInTheDocument();
    expect(screen.queryByText("question 0")).not.toBeInTheDocument();
    expect(revealButton()).toBeInTheDocument();
  });

  it("reveals every earlier turn when the control is used repeatedly", () => {
    render(<MessageList messages={transcript(60)} />);

    const hiddenCount = () => {
      const label = revealButton()?.textContent ?? "";
      return Number.parseInt(label.replace(/\D+/g, ""), 10);
    };

    let previous = hiddenCount();
    expect(previous).toBeGreaterThan(0);

    // Each click reveals strictly more, and never fewer, turns.
    while (revealButton()) {
      fireEvent.click(revealButton()!);
      const next = revealButton() ? hiddenCount() : 0;
      expect(next).toBeLessThan(previous);
      previous = next;
    }

    // Nothing is unreachable: the first turn is rendered once fully revealed.
    expect(screen.getByText("question 0")).toBeInTheDocument();
    expect(screen.getByText("answer 59")).toBeInTheDocument();
  });

  it("renders a short transcript in full, with no reveal control", () => {
    render(<MessageList messages={transcript(5)} />);

    expect(screen.getByText("question 0")).toBeInTheDocument();
    expect(screen.getByText("answer 4")).toBeInTheDocument();
    expect(revealButton()).not.toBeInTheDocument();
  });

  it("does not hide revealed turns again when new turns arrive", () => {
    const { rerender } = render(<MessageList messages={transcript(40)} />);
    fireEvent.click(revealButton()!);
    expect(screen.getByText("question 19")).toBeInTheDocument();

    rerender(<MessageList messages={transcript(45)} />);

    expect(screen.getByText("question 19")).toBeInTheDocument();
    expect(screen.getByText("answer 44")).toBeInTheDocument();
  });

  it("holds the window in place while the reader is scrolled back", () => {
    const messages = transcript(40);
    const { container, rerender } = render(<MessageList messages={messages} />);
    const scroller = container.querySelector<HTMLElement>(".overflow-y-auto")!;

    // jsdom reports zero layout, so fake a viewport scrolled into the history.
    Object.defineProperty(scroller, "scrollHeight", { value: 5000, configurable: true });
    Object.defineProperty(scroller, "clientHeight", { value: 500, configurable: true });
    scroller.scrollTop = 0;
    fireEvent.scroll(scroller);

    // The topmost rendered bubble is the first window boundary; new turns
    // arriving must not move it.
    const firstRendered = () =>
      screen.getAllByText(/^(question|answer) \d+$/)[0]!.textContent ?? "";

    const before = firstRendered();
    rerender(<MessageList messages={transcript(45)} />);

    // New turns append below without shifting what the reader is looking at.
    expect(firstRendered()).toBe(before);
    expect(screen.getByText("answer 44")).toBeInTheDocument();
  });
});
