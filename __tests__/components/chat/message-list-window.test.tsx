// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, render, screen, fireEvent } from "@testing-library/react";
import { MessageList } from "@/components/chat/message-list";
import type { Message } from "@/components/chat/types";
import { FakeResizeObserver, fireTranscriptResize } from "../../helpers/fake-resize-observer";

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

/** `turns` user/assistant pairs  two renderable groups per turn. */
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

/** The same shape under ids no other list holds. */
function otherTranscript(turns: number): Message[] {
  return transcript(turns).map((entry) => ({
    ...entry,
    id: `other ${entry.id}`,
    content: entry.content ? `other ${entry.content}` : entry.content,
  }));
}

function revealButton() {
  return screen.queryByRole("button", { name: /earlier messages?$/ });
}

/** One step of a run: a single tool call, so it renders one card. */
function step(index: number, parentMessageId: string): Message {
  return message({
    id: `s${index}`,
    role: "assistant",
    parentMessageId,
    toolCalls: [
      {
        id: `tc${index}`,
        name: "bash",
        args: { command: `step ${index}` },
        status: "completed",
        result: "ok",
        error: undefined,
      },
    ],
  });
}

/** A prompt, a short answer, and a run of `steps` tool calls under it. */
function longTurn(steps: number): Message[] {
  return [
    message({ id: "u0", role: "user", content: "do the thing" }),
    message({ id: "a0", role: "assistant", parentMessageId: "u0", content: "on it" }),
    ...Array.from({ length: steps }, (_, index) => step(index, "u0")),
  ];
}

const hiddenCount = () =>
  Number.parseInt((revealButton()?.textContent ?? "0").replace(/\D+/g, ""), 10);

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

describe("MessageList growth", () => {
  it("keeps a long turn on screen when the next one starts", () => {
    // A finished run costs one window's worth at most, so the turn that
    // follows it cannot crowd it out.
    const messages = [
      ...longTurn(200),
      message({ id: "u1", role: "user", content: "and now this" }),
      message({ id: "a1", role: "assistant", parentMessageId: "u1", content: "working on it" }),
    ];

    render(<MessageList messages={messages} isLoading />);

    // The long turn is mounted, folded by its own step control, and its prompt
    // is mounted with it.
    expect(screen.getByText("step 199")).toBeInTheDocument();
    expect(screen.getByText("do the thing")).toBeInTheDocument();
    expect(screen.getByText("working on it")).toBeInTheDocument();
    expect(revealButton()).not.toBeInTheDocument();
  });

  it("counts a condensed run as a line, not as its steps", () => {
    const messages = [
      ...longTurn(200),
      message({ id: "u1", role: "user", content: "and now this" }),
      message({ id: "a1", role: "assistant", parentMessageId: "u1", content: "working on it" }),
    ];

    render(<MessageList messages={messages} compactActivity isLoading />);

    // Both turns fold into a line each, so nothing is hidden.
    expect(revealButton()).not.toBeInTheDocument();
    expect(screen.getByText("Used 200 tools")).toBeInTheDocument();
    expect(screen.getByText("working on it")).toBeInTheDocument();
    expect(screen.getByText("do the thing")).toBeInTheDocument();
  });

  it("keeps the turns above a long run in the window as it works", () => {
    const turn = longTurn(200);
    const run = (steps: number): Message[] => [
      ...turn,
      message({ id: "u1", role: "user", content: "and now this" }),
      message({ id: "a1", role: "assistant", parentMessageId: "u1", content: "working on it" }),
      ...Array.from({ length: steps }, (_, index) => step(10_000 + index, "u1")),
    ];
    const { rerender } = render(<MessageList messages={run(0)} isLoading />);

    for (const steps of [1, 20, 120, 200]) {
      rerender(<MessageList messages={run(steps)} isLoading />);
      // The finished turn stays where it was: the run below it appends.
      expect(screen.getByText("do the thing")).toBeInTheDocument();
      expect(screen.getByText("step 199")).toBeInTheDocument();
      expect(revealButton()).not.toBeInTheDocument();
    }
  });

  it("holds the window while a run adds steps", () => {
    const earlier = transcript(40);
    const running = (steps: number): Message[] => [
      ...earlier,
      message({ id: "u40", role: "user", content: "question 40" }),
      message({ id: "a40", role: "assistant", parentMessageId: "u40", content: "working" }),
      ...Array.from({ length: steps }, (_, index) => step(10_000 + index, "u40")),
    ];
    const { rerender } = render(<MessageList messages={running(0)} isLoading />);

    const firstRendered = () =>
      screen.getAllByText(/^(question|answer) \d+$/)[0]!.textContent ?? "";
    const before = { first: firstRendered(), hidden: hiddenCount() };
    expect(before.hidden).toBeGreaterThan(0);

    for (const steps of [1, 5, 20, 60]) {
      rerender(<MessageList messages={running(steps)} isLoading />);
      // A step arriving appends below the window; it does not retire a turn
      // that was on screen a moment ago.
      expect(firstRendered()).toBe(before.first);
      expect(hiddenCount()).toBe(before.hidden);
    }

    expect(screen.getByText("step 10059")).toBeInTheDocument();
  });

  it("never opens the window on an answer whose question is hidden", () => {
    // Forty turns, twenty groups of them mounted: whichever pair the budget
    // lands on, the prompt comes with its answer.
    render(<MessageList messages={transcript(40)} />);

    expect(hiddenCount()).toBeGreaterThan(0);
    expect(screen.getAllByText(/^question \d+$/)).toHaveLength(
      screen.getAllByText(/^answer \d+$/).length,
    );
  });

  it("paginates again when the transcript is replaced", () => {
    const { rerender } = render(<MessageList messages={transcript(40)} />);
    fireEvent.click(revealButton()!);
    expect(screen.getByText("question 19")).toBeInTheDocument();

    // Another conversation: the held window names a turn this list does not
    // have, so the window is the tail of what it now holds.
    rerender(<MessageList messages={otherTranscript(40)} />);

    expect(screen.getByText("other answer 39")).toBeInTheDocument();
    expect(screen.queryByText("other question 0")).not.toBeInTheDocument();
    expect(screen.queryByText("question 19")).not.toBeInTheDocument();
  });

  it("shows the tail when the transcript shrinks under a revealed window", () => {
    const { rerender } = render(<MessageList messages={transcript(40)} />);
    fireEvent.click(revealButton()!);
    expect(screen.getByText("question 19")).toBeInTheDocument();

    // A compaction leaves a short transcript where the revealed window started.
    rerender(<MessageList messages={transcript(3)} />);

    expect(screen.getByText("question 0")).toBeInTheDocument();
    expect(screen.getByText("answer 2")).toBeInTheDocument();
    expect(revealButton()).not.toBeInTheDocument();
  });

  it("offers the page above once everything loaded is revealed", () => {
    const onLoadEarlier = vi.fn();
    render(<MessageList messages={transcript(5)} hasEarlier onLoadEarlier={onLoadEarlier} />);

    const control = screen.getByRole("button", { name: "Show earlier messages" });
    fireEvent.click(control);

    expect(onLoadEarlier).toHaveBeenCalledTimes(1);
  });

  it("counts a single hidden message in the singular", () => {
    const messages = [
      message({ id: "u0", role: "user", content: "question 0" }),
      ...transcript(10).map((entry) => ({ ...entry, id: `later ${entry.id}` })),
    ];

    render(<MessageList messages={messages} />);

    // Twenty-one render groups: the first turn is the one left above the window.
    expect(revealButton()).toHaveTextContent("Show 1 earlier message");
  });
});

describe("MessageList folding a turn", () => {
  const earlierSteps = () => screen.queryByRole("button", { name: /earlier steps?$/ });

  it("keeps a run's unfolded steps on screen as it grows", () => {
    const { rerender } = render(<MessageList messages={longTurn(230)} isLoading />);

    // The run's oldest steps fold away behind a control.
    expect(earlierSteps()).toHaveTextContent("Show 81 earlier steps");
    fireEvent.click(earlierSteps()!);
    expect(earlierSteps()).toHaveTextContent("Show 21 earlier steps");

    // Steps arriving append below the unfold instead of pushing it along.
    const grown = [...longTurn(230)];
    for (let index = 230; index < 240; index++) {
      grown.push(step(index, "u0"));
      rerender(<MessageList messages={[...grown]} isLoading />);
    }

    expect(earlierSteps()).toHaveTextContent("Show 21 earlier steps");
    expect(screen.getByText("step 230")).toBeInTheDocument();
  });
});

describe("MessageList reading back", () => {
  /** A row's height, so a prepend can be measured in jsdom's layout-free world. */
  const ROW_PX = 100;

  /** How far down the transcript an element sits, in the fake layout. */
  function rowOffset(el: HTMLElement): number {
    let top = 0;
    for (let node: HTMLElement | null = el; node; node = node.parentElement) top += node.offsetTop;
    return top;
  }

  beforeEach(() => {
    FakeResizeObserver.instances = [];
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    // jsdom lays nothing out: rows sit one below the next in their parent.
    Object.defineProperty(HTMLElement.prototype, "offsetTop", {
      configurable: true,
      get(this: HTMLElement) {
        const parent = this.parentElement;
        return parent ? [...parent.children].indexOf(this) * ROW_PX : 0;
      },
    });
    // The same stack as a rect, so a row's place on screen is the offsets the
    // scroller's own scroll moves.
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      const scroller = this.closest<HTMLElement>("[data-transcript]");
      const scrolled = scroller && scroller !== this ? scroller.scrollTop : 0;
      return new DOMRect(0, rowOffset(this) - scrolled, 0, ROW_PX);
    };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(HTMLElement.prototype, "offsetTop");
    Reflect.deleteProperty(HTMLElement.prototype, "getBoundingClientRect");
  });

  /**
   * Put the reader at the top of the transcript, the only place the reveal
   * control is reachable, with following released the way their scroll to it
   * released it.
   */
  function openAtTop(container: HTMLElement) {
    const scroller = container.querySelector<HTMLElement>(".overflow-y-auto")!;
    Object.defineProperty(scroller, "scrollHeight", { value: 5000, configurable: true });
    Object.defineProperty(scroller, "clientHeight", { value: 500, configurable: true });
    scroller.scrollTop = 200;
    fireEvent.wheel(scroller, { deltaY: -120 });
    scroller.scrollTop = 0;
    fireEvent.scroll(scroller);
    // The browser's first size report, which is where the list measures from.
    act(() => fireTranscriptResize("content"));
    return scroller;
  }

  it("keeps the reader's place when earlier turns are revealed", () => {
    const { container } = render(<MessageList messages={transcript(60)} />);
    const scroller = openAtTop(container);
    const content = container.querySelector<HTMLElement>("[data-transcript] > div")!;

    // Where the tail row sits relative to the viewport is the reader's place.
    const place = () => (content.lastElementChild as HTMLElement).offsetTop - scroller.scrollTop;
    const before = place();

    fireEvent.click(revealButton()!);
    act(() => fireTranscriptResize("content"));

    // The revealed turns landed above the view, pushing it down with them.
    expect(scroller.scrollTop).toBeGreaterThan(0);
    expect(place()).toBe(before);
    expect(screen.getByText("question 35")).toBeInTheDocument();
  });

  it("leaves the reader alone when a turn is added below", () => {
    const { container, rerender } = render(<MessageList messages={transcript(60)} />);
    const scroller = openAtTop(container);

    rerender(<MessageList messages={transcript(61)} />);
    act(() => fireTranscriptResize("content"));

    // Growth below the view is not the reader's place moving.
    expect(scroller.scrollTop).toBe(0);
  });
});
