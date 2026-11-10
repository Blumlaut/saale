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
