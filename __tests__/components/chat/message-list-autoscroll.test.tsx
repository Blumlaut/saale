// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { createRef } from "react";
import { act, render, screen, fireEvent } from "@testing-library/react";
import { MessageList, type MessageListHandle } from "@/components/chat/message-list";
import type { Message } from "@/components/chat/types";

/**
 * Auto-scroll: the list follows the tail while armed, and the user's own scroll
 * always wins. "Wins" covers more than a wheel tick. a transcript that a
 * collapsing tool card shortens clamps itself to its new tail, and that clamp
 * used to count as the user arriving at the bottom, turning following back on
 * under a reader who had scrolled away. Only input re-arms the follow now.
 */

/**
 * jsdom has no layout, so the transcript's own height changes (a thinking block
 * unfolding, a tool card reporting output) are driven by hand.
 */
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  active = true;
  target: Element | null = null;
  constructor(private readonly cb: () => void) {
    FakeResizeObserver.instances.push(this);
  }
  observe(target: Element) {
    this.target = target;
  }
  disconnect() {
    this.active = false;
  }
  /** Report a resize, the way the browser does after layout. */
  fire() {
    if (this.active) this.cb();
  }
}

/** The transcript is the scroller; the box observers watch it, the rest watch the content. */
function fireObservers(onScroller: boolean) {
  for (const observer of FakeResizeObserver.instances) {
    const watchesScroller = observer.target?.matches(".overflow-y-auto") ?? false;
    if (watchesScroller === onScroller) observer.fire();
  }
}

/** Content height changed without any message changing. */
function contentResized() {
  fireObservers(false);
}

/** The box itself was resized: the on-screen keyboard, or the composer growing. */
function boxResized() {
  fireObservers(true);
}

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
      message({ id: `a${i}`, role: "assistant", content: `answer ${i}` }),
    );
  }
  return messages;
}

function scrollerOf(container: HTMLElement): HTMLElement {
  return container.querySelector<HTMLElement>(".overflow-y-auto")!;
}

const VIEWPORT = 500;
/** The box the transcript scrolls in: phones resize it as the keyboard comes and goes. */
let boxHeight = VIEWPORT;
/** What the transcript is worth once {@link layout} has been applied. */
let contentHeight = 5000;

/**
 * Give the scroller a layout: `contentHeight` of content in a `boxHeight`-tall
 * box. jsdom reports 0 for both without this.
 */
function layout(container: HTMLElement, scrollHeight = contentHeight): HTMLElement {
  const scroller = scrollerOf(container);
  Object.defineProperty(scroller, "scrollHeight", { value: scrollHeight, configurable: true });
  Object.defineProperty(scroller, "clientHeight", { value: boxHeight, configurable: true });
  return scroller;
}

/** The offset that pins the view to the tail. */
function tailOf(container: HTMLElement, scrollHeight = contentHeight): number {
  return Math.max(0, scrollHeight - boxHeight);
}

/** Put the scroller at `scrollTop` and deliver the scroll event a browser sends. */
function scrollTo(container: HTMLElement, scrollTop: number, scrollHeight?: number): HTMLElement {
  const scroller = layout(container, scrollHeight);
  scroller.scrollTop = scrollTop;
  fireEvent.scroll(scroller);
  return scroller;
}

/** Sit on the tail, the way a follow leaves the view. */
function settleAtTail(container: HTMLElement, scrollHeight?: number): HTMLElement {
  return scrollTo(container, tailOf(container, scrollHeight), scrollHeight);
}

function jumpButton() {
  return screen.queryByRole("button", { name: "Jump to the latest message" });
}

/** Let the input grace window lapse, as it does while a stream pauses. */
function letInputGoStale() {
  act(() => {
    vi.advanceTimersByTime(2000);
  });
}

beforeEach(() => {
  contentHeight = 5000;
  boxHeight = VIEWPORT;
  FakeResizeObserver.instances = [];
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("MessageList auto-scroll", () => {
  it("jumps to the latest message when the list first has a layout", () => {
    // jsdom lays nothing out, so the transcript's first height report is what
    // tells the list it can scroll at all (see the resize observer above).
    const { container } = render(<MessageList messages={transcript(5)} />);
    layout(container);
    act(() => contentResized());
    expect(scrollerOf(container).scrollTop).toBe(tailOf(container));
  });

  it("follows the tail on every content change while armed", () => {
    const { container, rerender } = render(<MessageList messages={transcript(2)} isLoading />);
    layout(container);
    contentHeight = 6000;
    layout(container);
    rerender(<MessageList messages={transcript(3)} isLoading />);
    expect(scrollerOf(container).scrollTop).toBe(tailOf(container));
  });

  it("follows a transcript that grows taller without a new message", () => {
    // A thinking block unfolding or a tool card reporting live output adds
    // thousands of px with the same messages. A reader on the tail stays there.
    const { container } = render(<MessageList messages={transcript(2)} isLoading />);
    layout(container);
    const before = scrollerOf(container).scrollTop;

    contentHeight = 7200;
    layout(container);
    act(() => contentResized());

    expect(before).toBeLessThan(tailOf(container));
    expect(scrollerOf(container).scrollTop).toBe(tailOf(container));
  });

  it("watches the transcript that arrives after the first render", () => {
    // A chat fetches its messages, so the transcript is not there when the
    // effect that sets up the observers first runs. Growth that no message
    // change reports (an unfolded block, a panel dragged wider) still has to
    // reach the follow once the messages land.
    const { container, rerender } = render(<MessageList messages={[]} isLoading />);
    rerender(<MessageList messages={transcript(3)} isLoading />);
    layout(container);

    contentHeight = 7000;
    layout(container);
    act(() => contentResized());

    expect(scrollerOf(container).scrollTop).toBe(tailOf(container));
  });

  it("keeps following when a block is unfolded by a click", () => {
    // Unfolding a thinking block presses on the transcript and grows it in the
    // same breath. The press is a click, not the reader scrolling away, so the
    // view stays on the tail it was watching.
    const { container } = render(<MessageList messages={transcript(2)} isLoading />);
    const scroller = settleAtTail(container);

    fireEvent.pointerDown(scroller, { offsetX: 10 });
    act(() => {
      window.dispatchEvent(new Event("pointerup"));
    });
    contentHeight = 6200;
    layout(container);
    act(() => contentResized());

    expect(scroller.scrollTop).toBe(tailOf(container));
  });

  it("leaves a reader who scrolled away alone while the transcript grows", () => {
    // Reading back is the reader's place to keep: a tool card unfolding above
    // them shifts nothing they are looking at.
    const { container } = render(<MessageList messages={transcript(3)} isLoading />);
    const scroller = settleAtTail(container);
    const readingAt = tailOf(container) - 900;
    fireEvent.wheel(scroller, { deltaY: -120 });
    scrollTo(container, readingAt);

    contentHeight = 7200;
    layout(container);
    act(() => contentResized());

    expect(scroller.scrollTop).toBe(readingAt);
  });

  it("keeps following a block unfolding after the reader returns to the tail", () => {
    const { container } = render(<MessageList messages={transcript(3)} isLoading />);
    const scroller = settleAtTail(container);
    fireEvent.wheel(scroller, { deltaY: -120 });
    scrollTo(container, tailOf(container) - 900);

    fireEvent.click(jumpButton()!);
    contentHeight = 6600;
    layout(container);
    act(() => contentResized());

    expect(scroller.scrollTop).toBe(tailOf(container));
  });

  it("keeps the reader's place on a wheel tick smaller than the old 80px band", () => {
    const { container, rerender } = render(<MessageList messages={transcript(2)} isLoading />);
    const scroller = settleAtTail(container);

    // One notch up: 20px from the tail, still inside any "at bottom" band.
    scrollTo(container, tailOf(container) - 20);
    rerender(<MessageList messages={transcript(4)} isLoading />);
    expect(scroller.scrollTop).toBe(tailOf(container) - 20);
  });

  it("does not follow while the reader's input is still fresh", () => {
    const { container, rerender } = render(<MessageList messages={transcript(2)} isLoading />);
    const scroller = settleAtTail(container);

    // The wheel turned down at the tail: following is what they want, but not
    // in the middle of their gesture.
    fireEvent.wheel(scroller, { deltaY: 120 });
    contentHeight = 6000;
    layout(container);
    rerender(<MessageList messages={transcript(3)} isLoading />);
    expect(scroller.scrollTop).toBeLessThan(tailOf(container));

    letInputGoStale();
    rerender(<MessageList messages={transcript(4)} isLoading />);
    expect(scroller.scrollTop).toBe(tailOf(container));
  });

  it("stops following the moment the wheel turns up, before its scroll event", () => {
    const { container, rerender } = render(<MessageList messages={transcript(2)} isLoading />);
    const scroller = settleAtTail(container);

    // The browser has not reported the new position yet: only the input tells
    // the list the user is on their way up.
    fireEvent.wheel(scroller, { deltaY: -120 });
    rerender(<MessageList messages={transcript(4)} isLoading />);
    expect(scroller.scrollTop).toBe(tailOf(container));
  });

  it("stays armed when a wheel has nothing to scroll (short transcript)", () => {
    const { container, rerender } = render(<MessageList messages={transcript(2)} isLoading />);
    const scroller = scrollTo(container, 0, VIEWPORT);

    fireEvent.wheel(scroller, { deltaY: -120 });
    letInputGoStale();

    contentHeight = 6000;
    layout(container);
    rerender(<MessageList messages={transcript(4)} isLoading />);
    expect(scroller.scrollTop).toBe(tailOf(container));
  });

  it("stops following when the user drags the scrollbar up", () => {
    const { container, rerender } = render(<MessageList messages={transcript(2)} isLoading />);
    const scroller = settleAtTail(container);

    // A drag reports positions the follow never aimed at: above the last one.
    const draggedTo = tailOf(container) - 400;
    scrollTo(container, draggedTo);
    contentHeight = 6000;
    layout(container);
    rerender(<MessageList messages={transcript(4)} isLoading />);
    expect(scroller.scrollTop).toBe(draggedTo);
  });

  it("does not re-arm from a clamp at the tail that no input caused", () => {
    // A tool card collapsing (or a turn being saved) shortens the transcript
    // and the browser clamps the view to the new tail. That is not the reader
    // arriving there on purpose, and following must stay off.
    const { container, rerender } = render(<MessageList messages={transcript(3)} isLoading />);
    const scroller = settleAtTail(container);
    scrollTo(container, tailOf(container) - 400);

    // The transcript shrinks under them: the browser clamps to the tail.
    contentHeight = 2000;
    layout(container);
    scrollTo(container, tailOf(container));

    contentHeight = 4000;
    layout(container);
    rerender(<MessageList messages={transcript(4)} isLoading />);
    expect(scroller.scrollTop).toBeLessThan(tailOf(container));
  });

  it("keeps following when the box grows and clamps the view to a shorter tail", () => {
    // The on-screen keyboard closing (or the URL bar coming back) grows the
    // shell, so the browser clamps the view up to the new, shorter tail. That
    // is not the reader leaving, and the reply that follows would scroll off.
    const { container, rerender } = render(<MessageList messages={transcript(3)} isLoading />);
    const scroller = settleAtTail(container);

    boxHeight = 700;
    scrollTo(container, tailOf(container));

    contentHeight = 6000;
    layout(container);
    rerender(<MessageList messages={transcript(4)} isLoading />);
    expect(scroller.scrollTop).toBe(tailOf(container));
  });

  it("follows the tail when the box shrinks under a followed view", () => {
    // The keyboard opening shortens the box: the tail moves away with no new
    // message to follow it, so the follow has to notice the box itself.
    const { container } = render(<MessageList messages={transcript(3)} isLoading />);
    const scroller = settleAtTail(container);

    boxHeight = 300;
    layout(container);
    act(() => boxResized());

    expect(scroller.scrollTop).toBe(tailOf(container));
  });

  it("leaves a reader who scrolled away alone when the box resizes", () => {
    const { container } = render(<MessageList messages={transcript(3)} isLoading />);
    const scroller = settleAtTail(container);
    const readingAt = tailOf(container) - 400;
    scrollTo(container, readingAt);

    boxHeight = 300;
    layout(container);
    act(() => boxResized());

    expect(scroller.scrollTop).toBe(readingAt);
  });

  it("stops following when the scrollbar thumb is grabbed", () => {
    const { container, rerender } = render(<MessageList messages={transcript(2)} isLoading />);
    const scroller = settleAtTail(container);
    Object.defineProperty(scroller, "offsetWidth", { value: 516, configurable: true });

    fireEvent.pointerDown(scroller, { offsetX: 510 });

    contentHeight = 6000;
    layout(container);
    rerender(<MessageList messages={transcript(4)} isLoading />);
    expect(scroller.scrollTop).toBeLessThan(tailOf(container));
  });

  it("keeps following once the pointer is released", () => {
    const { container, rerender } = render(<MessageList messages={transcript(2)} isLoading />);
    const scroller = settleAtTail(container);

    fireEvent.pointerDown(scroller, { offsetX: 10 });
    act(() => {
      window.dispatchEvent(new Event("pointerup"));
    });
    letInputGoStale();

    contentHeight = 6000;
    layout(container);
    rerender(<MessageList messages={transcript(4)} isLoading />);
    expect(scroller.scrollTop).toBe(tailOf(container));
  });

  it("stops following when the user pages up from inside the list", () => {
    const { container, rerender } = render(<MessageList messages={transcript(2)} isLoading />);
    const scroller = settleAtTail(container);

    fireEvent.keyDown(scroller, { key: "PageUp" });
    contentHeight = 6000;
    layout(container);
    rerender(<MessageList messages={transcript(4)} isLoading />);
    expect(scroller.scrollTop).toBeLessThan(tailOf(container));
  });

  it("keeps following on keys that do not scroll", () => {
    const { container, rerender } = render(<MessageList messages={transcript(2)} isLoading />);
    const scroller = settleAtTail(container);

    fireEvent.keyDown(scroller, { key: "c" });
    contentHeight = 6000;
    layout(container);
    rerender(<MessageList messages={transcript(4)} isLoading />);
    expect(scroller.scrollTop).toBe(tailOf(container));
  });

  it("lands on the tail when the user presses End", () => {
    const { container } = render(<MessageList messages={transcript(3)} isLoading />);
    const scroller = settleAtTail(container);
    scrollTo(container, tailOf(container) - 400);

    fireEvent.keyDown(scroller, { key: "End" });
    letInputGoStale();

    contentHeight = 6000;
    layout(container);
    act(() => contentResized());
    expect(scroller.scrollTop).toBe(tailOf(container));
  });

  it("stops following when a finger drags earlier turns into view", () => {
    const { container, rerender } = render(<MessageList messages={transcript(2)} isLoading />);
    const scroller = settleAtTail(container);

    fireEvent.touchStart(scroller, { touches: [{ clientY: 200 }] });
    fireEvent.touchMove(scroller, { touches: [{ clientY: 260 }] });

    contentHeight = 6000;
    layout(container);
    rerender(<MessageList messages={transcript(4)} isLoading />);
    expect(scroller.scrollTop).toBeLessThan(tailOf(container));
  });

  it("follows again once the finger drags back to the tail", () => {
    const { container } = render(<MessageList messages={transcript(2)} isLoading />);
    const scroller = settleAtTail(container);
    fireEvent.touchStart(scroller, { touches: [{ clientY: 200 }] });
    fireEvent.touchMove(scroller, { touches: [{ clientY: 260 }] });

    fireEvent.touchStart(scroller, { touches: [{ clientY: 260 }] });
    fireEvent.touchMove(scroller, { touches: [{ clientY: 200 }] });
    letInputGoStale();

    contentHeight = 6000;
    layout(container);
    act(() => contentResized());
    expect(scroller.scrollTop).toBe(tailOf(container));
  });

  it("follows a turn that grows further than any fixed band", () => {
    // A tool card / code block can add thousands of px in one commit. The view
    // is still on the tail it was on; the new tail is simply far below it.
    const { container, rerender } = render(<MessageList messages={transcript(3)} isLoading />);
    const scroller = settleAtTail(container);

    contentHeight = 12_000;
    layout(container);
    rerender(<MessageList messages={transcript(4)} isLoading />);
    expect(scroller.scrollTop).toBe(tailOf(container));
  });

  it("follows again once the user scrolls back down to the tail", () => {
    const { container, rerender } = render(<MessageList messages={transcript(3)} isLoading />);
    const scroller = settleAtTail(container);
    scrollTo(container, tailOf(container) - 400);

    // Reaching the tail is the user's arrival only when their input explains
    // it: a bare scroll event is the browser's doing (see the clamp test).
    fireEvent.wheel(scroller, { deltaY: 120 });
    settleAtTail(container);
    letInputGoStale();
    contentHeight = 6000;
    layout(container);
    rerender(<MessageList messages={transcript(4)} isLoading />);
    expect(scroller.scrollTop).toBe(tailOf(container));
  });

  it("re-arms when the user scrolls down into the tail band", () => {
    const { container, rerender } = render(<MessageList messages={transcript(3)} isLoading />);
    const scroller = settleAtTail(container);
    scrollTo(container, tailOf(container) - 400);

    // Down, and close enough to the tail that arriving is the intent. The wheel
    // is the input behind it: a scrollbar drag reports movement, not intent.
    fireEvent.wheel(scroller, { deltaY: 60 });
    scrollTo(container, tailOf(container) - 60);
    letInputGoStale();

    contentHeight = 6000;
    layout(container);
    rerender(<MessageList messages={transcript(4)} isLoading />);
    expect(scroller.scrollTop).toBe(tailOf(container));
  });

  it("does not re-arm when the user stops just short of the tail scrolling up", () => {
    const { container, rerender } = render(<MessageList messages={transcript(3)} isLoading />);
    const scroller = settleAtTail(container);

    // Inside the band, but moving away from the tail: still the user's call.
    const stoppedAt = tailOf(container) - 60;
    scrollTo(container, stoppedAt);
    contentHeight = 6000;
    layout(container);
    rerender(<MessageList messages={transcript(4)} isLoading />);
    expect(scroller.scrollTop).toBe(stoppedAt);
  });

  it("hides the jump button at the bottom and shows it while reading history", () => {
    const { container } = render(<MessageList messages={transcript(5)} />);
    settleAtTail(container);
    expect(jumpButton()).not.toBeInTheDocument();

    scrollTo(container, tailOf(container) - 400);
    expect(jumpButton()).toBeInTheDocument();
  });

  it("jumps to the bottom and re-arms auto-scroll when the button is used", () => {
    const { container, rerender } = render(<MessageList messages={transcript(3)} isLoading />);
    const scroller = settleAtTail(container);
    scrollTo(container, tailOf(container) - 400);

    fireEvent.click(jumpButton()!);

    // Jumped now, and armed again for the stream that follows.
    expect(scroller.scrollTop).toBe(tailOf(container));
    expect(jumpButton()).not.toBeInTheDocument();

    letInputGoStale();
    contentHeight = 6000;
    layout(container);
    rerender(<MessageList messages={transcript(4)} isLoading />);
    expect(scroller.scrollTop).toBe(tailOf(container));
  });

  it("re-arms auto-scroll via the imperative handle (send, approval)", () => {
    const ref = createRef<MessageListHandle>();
    const { container, rerender } = render(
      <MessageList ref={ref} messages={transcript(3)} isLoading />,
    );
    const scroller = settleAtTail(container);
    scrollTo(container, tailOf(container) - 400);

    act(() => {
      ref.current!.enableAutoScroll();
    });

    expect(scroller.scrollTop).toBe(tailOf(container));
    expect(jumpButton()).not.toBeInTheDocument();

    letInputGoStale();
    contentHeight = 6000;
    layout(container);
    rerender(<MessageList ref={ref} messages={transcript(4)} isLoading />);
    expect(scroller.scrollTop).toBe(tailOf(container));
  });
});
