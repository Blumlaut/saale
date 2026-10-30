// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MessageList } from "@/components/chat/message-list";
import type { Message, ToolCallData } from "@/components/chat/types";

/**
 * The render window's second budget: rows, not only turns.
 *
 * A coder turn runs hundreds of steps, and every step is its own message with
 * its own card. Twenty turns of a busy chat is therefore a window of thousands
 * of mounted components. These tests pin down what bounds that: the window
 * stops at a row budget, a single oversized turn folds its oldest steps, and
 * the folded ones stay reachable.
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

/** One step of a run: no prose, one tool call, so every row is a card. */
function step(index: number, parentMessageId: string): Message {
  return message({
    id: `s${index}`,
    role: "assistant",
    parentMessageId,
    toolCalls: [toolCall(index)],
  });
}

/** A single turn whose run took `steps` steps. */
function longTurn(steps: number): Message[] {
  return [
    message({ id: "u0", role: "user", content: "do the thing" }),
    message({ id: "a0", role: "assistant", parentMessageId: "u0", content: "on it" }),
    ...Array.from({ length: steps }, (_, i) => step(i, "u0")),
  ];
}

/** `turns` turns, each run taking `steps` steps. */
function busyTranscript(turns: number, steps: number): Message[] {
  const messages: Message[] = [];
  for (let turn = 0; turn < turns; turn++) {
    messages.push(
      message({ id: `u${turn}`, role: "user", content: `question ${turn}` }),
      message({ id: `a${turn}`, role: "assistant", content: `answer ${turn}` }),
      ...Array.from({ length: steps }, (_, i) => step(turn * 1000 + i, `u${turn}`)),
    );
  }
  return messages;
}

const earlierSteps = () => screen.queryByRole("button", { name: /earlier steps?$/ });
const earlierMessages = () => screen.queryByRole("button", { name: /earlier messages?$/ });

/** How many step cards are mounted: each renders the tool's own title. */
const cardCount = () => screen.queryAllByText("Bash").length;

/** The oldest turn on screen, by its question's index. */
function firstQuestionOnScreen(): number {
  const indices = screen
    .queryAllByText(/^question \d+$/)
    .map((node) => Number.parseInt(node.textContent!.replace(/\D+/g, ""), 10));
  return Math.min(...indices);
}

describe("MessageList row budget", () => {
  it(
    "folds the oldest steps of a single oversized turn behind a control",
    { timeout: 30_000 },
    () => {
      render(<MessageList messages={longTurn(200)} />);

      // The newest steps are on screen, the oldest are folded away.
      expect(screen.getByText("step 199")).toBeInTheDocument();
      expect(screen.queryByText("step 0")).not.toBeInTheDocument();

      // 201 rows in the run, the row budget's worth shown.
      expect(earlierSteps()).toHaveTextContent("Show 51 earlier steps");
      expect(cardCount()).toBe(150);
    },
  );

  it("reveals folded steps until the run is whole", { timeout: 30_000 }, () => {
    render(<MessageList messages={longTurn(200)} />);

    let previous = cardCount();
    while (earlierSteps()) {
      fireEvent.click(earlierSteps()!);
      expect(cardCount()).toBeGreaterThan(previous);
      previous = cardCount();
    }

    expect(cardCount()).toBe(200);
    expect(screen.getByText("step 0")).toBeInTheDocument();
    expect(screen.getByText("step 199")).toBeInTheDocument();
  });

  it("keeps a long turn condensed when the condensed transcript is on", () => {
    render(<MessageList messages={longTurn(200)} compactActivity />);

    // A run folds to a line each, so no step cards mount and nothing is hidden.
    expect(earlierSteps()).not.toBeInTheDocument();
    expect(cardCount()).toBe(0);
  });

  it("stops the turn window at the row budget, not at twenty turns", { timeout: 30_000 }, () => {
    render(<MessageList messages={busyTranscript(20, 20)} />);

    // A turn is 22 rows, so the window reaches six turns back rather than 20.
    expect(screen.getByText("question 19")).toBeInTheDocument();
    expect(screen.queryByText("question 0")).not.toBeInTheDocument();
    expect(screen.queryByText("question 12")).not.toBeInTheDocument();
    expect(firstQuestionOnScreen()).toBe(14);
    expect(earlierMessages()).toBeInTheDocument();
  });

  it("reveals every earlier turn of a busy transcript on demand", { timeout: 30_000 }, () => {
    render(<MessageList messages={busyTranscript(20, 20)} />);

    let previous = firstQuestionOnScreen();
    while (earlierMessages()) {
      fireEvent.click(earlierMessages()!);
      const next = firstQuestionOnScreen();
      expect(next).toBeLessThan(previous);
      previous = next;
    }

    // Nothing is unreachable.
    expect(screen.getByText("question 0")).toBeInTheDocument();
    expect(screen.getByText("question 19")).toBeInTheDocument();
  });

  it("drops a revealed window once the reader is back at the tail", { timeout: 30_000 }, () => {
    const { container } = render(<MessageList messages={busyTranscript(20, 20)} />);
    const scroller = container.querySelector<HTMLElement>(".overflow-y-auto")!;
    const hiddenCount = () => (earlierMessages()?.textContent ?? "").replace(/\D+/g, "");

    // jsdom reports zero layout, so fake a viewport scrolled into the history.
    Object.defineProperty(scroller, "scrollHeight", { value: 5000, configurable: true });
    Object.defineProperty(scroller, "clientHeight", { value: 500, configurable: true });
    scroller.scrollTop = 0;
    fireEvent.scroll(scroller);

    const atTail = { first: firstQuestionOnScreen(), hidden: hiddenCount() };

    fireEvent.click(earlierMessages()!);
    expect(firstQuestionOnScreen()).toBeLessThan(atTail.first);
    expect(Number(hiddenCount())).toBeLessThan(Number(atTail.hidden));

    // Back on the tail, the window is the tail again: what was revealed above
    // it does not stay mounted for the rest of the session.
    scroller.scrollTop = 4500;
    fireEvent.scroll(scroller);

    expect(firstQuestionOnScreen()).toBe(atTail.first);
    expect(hiddenCount()).toBe(atTail.hidden);
  });
});
