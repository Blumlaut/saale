// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { createRef } from "react";
import { act, render, screen, fireEvent } from "@testing-library/react";
import { MessageList, type MessageListHandle } from "@/components/chat/message-list";
import type { Message } from "@/components/chat/types";

/**
 * Auto-scroll: the list follows the tail while armed, and the user's own scroll
 * always wins — including a wheel tick small enough to leave the view inside the
 * "at bottom" band, which is exactly how a stream used to pull the view back down
 * under a reader. The jump-to-bottom button and the imperative handle re-arm it.
 */

type ScrollIntoViewSpy = ReturnType<typeof vi.fn<(arg?: boolean | ScrollIntoViewOptions) => void>>;

let scrollSpy: ScrollIntoViewSpy;

beforeEach(() => {
  scrollSpy = vi.fn<(arg?: boolean | ScrollIntoViewOptions) => void>();
  // jsdom has no layout, so scrollIntoView does not exist.
  Element.prototype.scrollIntoView = scrollSpy;
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
      message({ id: `a${i}`, role: "assistant", content: `answer ${i}` }),
    );
  }
  return messages;
}

function scrollerOf(container: HTMLElement): HTMLElement {
  return container.querySelector<HTMLElement>(".overflow-y-auto")!;
}

const VIEWPORT = 500;
const CONTENT = 5000;
/** The scroll offset that pins the view to the tail. */
const TAIL = CONTENT - VIEWPORT;

/**
 * Put the scroller at `scrollTop` and deliver the scroll event a browser sends
 * with it. A position with no event is not something the list can observe.
 */
function scrollTo(container: HTMLElement, scrollTop: number, scrollHeight = CONTENT): HTMLElement {
  const scroller = scrollerOf(container);
  Object.defineProperty(scroller, "scrollHeight", { value: scrollHeight, configurable: true });
  Object.defineProperty(scroller, "clientHeight", { value: VIEWPORT, configurable: true });
  scroller.scrollTop = scrollTop;
  fireEvent.scroll(scroller);
  return scroller;
}

/** Sit on the tail, the way a follow leaves the view. */
function settleAtTail(container: HTMLElement): HTMLElement {
  return scrollTo(container, TAIL);
}

function jumpButton() {
  return screen.queryByRole("button", { name: "Jump to the latest message" });
}

describe("MessageList auto-scroll", () => {
  it("jumps to the latest message when the list mounts with history", () => {
    render(<MessageList messages={transcript(5)} />);
    expect(scrollSpy).toHaveBeenCalledWith({ behavior: "auto" });
  });

  it("follows the tail on every content change while armed", () => {
    const { container, rerender } = render(<MessageList messages={transcript(2)} isLoading />);
    settleAtTail(container);
    const armed = scrollSpy.mock.calls.length;

    rerender(<MessageList messages={transcript(3)} isLoading />);
    expect(scrollSpy.mock.calls.length).toBeGreaterThan(armed);
  });

  it("keeps the reader's place on a wheel tick smaller than the old 80px band", () => {
    const { container, rerender } = render(<MessageList messages={transcript(2)} isLoading />);
    settleAtTail(container);

    // One notch up: 20px from the tail, still inside any "at bottom" band.
    scrollTo(container, TAIL - 20);
    const afterScrollUp = scrollSpy.mock.calls.length;

    rerender(<MessageList messages={transcript(4)} isLoading />);
    expect(scrollSpy.mock.calls.length).toBe(afterScrollUp);
  });

  it("stops following the moment the wheel turns up, before its scroll event", () => {
    const { container, rerender } = render(<MessageList messages={transcript(2)} isLoading />);
    const scroller = settleAtTail(container);
    const armed = scrollSpy.mock.calls.length;

    // The browser has not reported the new position yet: only the input tells
    // the list the user is on their way up.
    fireEvent.wheel(scroller, { deltaY: -120 });

    rerender(<MessageList messages={transcript(4)} isLoading />);
    expect(scrollSpy.mock.calls.length).toBe(armed);
  });

  it("keeps following when the wheel points at the tail", () => {
    const { container, rerender } = render(<MessageList messages={transcript(2)} isLoading />);
    const scroller = settleAtTail(container);
    const armed = scrollSpy.mock.calls.length;

    fireEvent.wheel(scroller, { deltaY: 120 });

    rerender(<MessageList messages={transcript(4)} isLoading />);
    expect(scrollSpy.mock.calls.length).toBeGreaterThan(armed);
  });

  it("stays armed when a wheel has nothing to scroll (short transcript)", () => {
    const { container, rerender } = render(<MessageList messages={transcript(2)} isLoading />);
    const scroller = scrollTo(container, 0, VIEWPORT);
    const armed = scrollSpy.mock.calls.length;

    fireEvent.wheel(scroller, { deltaY: -120 });

    rerender(<MessageList messages={transcript(4)} isLoading />);
    expect(scrollSpy.mock.calls.length).toBeGreaterThan(armed);
  });

  it("stops following when the user drags the scrollbar up", () => {
    const { container, rerender } = render(<MessageList messages={transcript(2)} isLoading />);
    settleAtTail(container);

    // A drag reports positions the follow never aimed at: above the last one.
    scrollTo(container, TAIL - 400);
    const afterDrag = scrollSpy.mock.calls.length;

    rerender(<MessageList messages={transcript(4)} isLoading />);
    expect(scrollSpy.mock.calls.length).toBe(afterDrag);
  });

  it("stops following when the scrollbar thumb is grabbed", () => {
    const { container, rerender } = render(<MessageList messages={transcript(2)} isLoading />);
    const scroller = settleAtTail(container);
    Object.defineProperty(scroller, "offsetWidth", { value: 516, configurable: true });
    const armed = scrollSpy.mock.calls.length;

    fireEvent.pointerDown(scroller, { offsetX: 510 });

    rerender(<MessageList messages={transcript(4)} isLoading />);
    expect(scrollSpy.mock.calls.length).toBe(armed);
  });

  it("stops following when the user pages up from inside the list", () => {
    const { container, rerender } = render(<MessageList messages={transcript(2)} isLoading />);
    const scroller = settleAtTail(container);
    const armed = scrollSpy.mock.calls.length;

    fireEvent.keyDown(scroller, { key: "PageUp" });

    rerender(<MessageList messages={transcript(4)} isLoading />);
    expect(scrollSpy.mock.calls.length).toBe(armed);
  });

  it("keeps following on keys that do not scroll", () => {
    const { container, rerender } = render(<MessageList messages={transcript(2)} isLoading />);
    const scroller = settleAtTail(container);
    const armed = scrollSpy.mock.calls.length;

    fireEvent.keyDown(scroller, { key: "c" });

    rerender(<MessageList messages={transcript(4)} isLoading />);
    expect(scrollSpy.mock.calls.length).toBeGreaterThan(armed);
  });

  it("stops following when a finger drags earlier turns into view", () => {
    const { container, rerender } = render(<MessageList messages={transcript(2)} isLoading />);
    const scroller = settleAtTail(container);
    const armed = scrollSpy.mock.calls.length;

    fireEvent.touchStart(scroller, { touches: [{ clientY: 200 }] });
    fireEvent.touchMove(scroller, { touches: [{ clientY: 260 }] });

    rerender(<MessageList messages={transcript(4)} isLoading />);
    expect(scrollSpy.mock.calls.length).toBe(armed);
  });

  it("follows again once the finger drags back to the tail", () => {
    const { container, rerender } = render(<MessageList messages={transcript(2)} isLoading />);
    const scroller = settleAtTail(container);
    fireEvent.touchStart(scroller, { touches: [{ clientY: 200 }] });
    fireEvent.touchMove(scroller, { touches: [{ clientY: 260 }] });
    const detached = scrollSpy.mock.calls.length;

    fireEvent.touchStart(scroller, { touches: [{ clientY: 260 }] });
    fireEvent.touchMove(scroller, { touches: [{ clientY: 200 }] });
    const rearmed = scrollSpy.mock.calls.length;
    expect(rearmed).toBeGreaterThan(detached);

    rerender(<MessageList messages={transcript(4)} isLoading />);
    expect(scrollSpy.mock.calls.length).toBeGreaterThan(rearmed);
  });

  it("follows a turn that grows further than any fixed band", () => {
    const { container, rerender } = render(<MessageList messages={transcript(2)} isLoading />);
    settleAtTail(container);
    const armed = scrollSpy.mock.calls.length;

    // A tool card / code block can add thousands of px in one commit. The view
    // is still on the tail it was on; the new tail is simply far below it.
    rerender(<MessageList messages={transcript(3)} isLoading />);
    scrollTo(container, TAIL, 12_000);
    rerender(<MessageList messages={transcript(4)} isLoading />);
    expect(scrollSpy.mock.calls.length).toBeGreaterThan(armed);
  });

  it("follows again once the user scrolls back down to the tail", () => {
    const { container, rerender } = render(<MessageList messages={transcript(3)} isLoading />);
    settleAtTail(container);
    scrollTo(container, TAIL - 400);

    settleAtTail(container);
    const rearmed = scrollSpy.mock.calls.length;

    rerender(<MessageList messages={transcript(4)} isLoading />);
    expect(scrollSpy.mock.calls.length).toBeGreaterThan(rearmed);
  });

  it("re-arms when the user scrolls down into the tail band", () => {
    const { container, rerender } = render(<MessageList messages={transcript(3)} isLoading />);
    settleAtTail(container);
    scrollTo(container, TAIL - 400);

    // Down, and close enough to the tail that arriving is the intent.
    scrollTo(container, TAIL - 60);
    const rearmed = scrollSpy.mock.calls.length;

    rerender(<MessageList messages={transcript(4)} isLoading />);
    expect(scrollSpy.mock.calls.length).toBeGreaterThan(rearmed);
  });

  it("does not re-arm when the user stops just short of the tail scrolling up", () => {
    const { container, rerender } = render(<MessageList messages={transcript(3)} isLoading />);
    settleAtTail(container);

    // Inside the band, but moving away from the tail: still the user's call.
    scrollTo(container, TAIL - 60);
    const afterScrollUp = scrollSpy.mock.calls.length;

    rerender(<MessageList messages={transcript(4)} isLoading />);
    expect(scrollSpy.mock.calls.length).toBe(afterScrollUp);
  });

  it("hides the jump button at the bottom and shows it while reading history", () => {
    const { container } = render(<MessageList messages={transcript(5)} />);
    settleAtTail(container);
    expect(jumpButton()).not.toBeInTheDocument();

    scrollTo(container, TAIL - 400);
    expect(jumpButton()).toBeInTheDocument();
  });

  it("jumps to the bottom and re-arms auto-scroll when the button is used", () => {
    const { container, rerender } = render(<MessageList messages={transcript(3)} isLoading />);
    settleAtTail(container);
    scrollTo(container, TAIL - 400);
    const afterScrollUp = scrollSpy.mock.calls.length;

    fireEvent.click(jumpButton()!);

    // Jumped now, and armed again for the stream that follows.
    expect(scrollSpy.mock.calls.length).toBeGreaterThan(afterScrollUp);
    expect(jumpButton()).not.toBeInTheDocument();

    const afterJump = scrollSpy.mock.calls.length;
    rerender(<MessageList messages={transcript(4)} isLoading />);
    expect(scrollSpy.mock.calls.length).toBeGreaterThan(afterJump);
  });

  it("re-arms auto-scroll via the imperative handle (send, approval)", () => {
    const ref = createRef<MessageListHandle>();
    const { container, rerender } = render(
      <MessageList ref={ref} messages={transcript(3)} isLoading />,
    );
    settleAtTail(container);
    scrollTo(container, TAIL - 400);
    const afterScrollUp = scrollSpy.mock.calls.length;

    act(() => {
      ref.current!.enableAutoScroll();
    });

    expect(scrollSpy.mock.calls.length).toBeGreaterThan(afterScrollUp);
    expect(jumpButton()).not.toBeInTheDocument();

    const afterJump = scrollSpy.mock.calls.length;
    rerender(<MessageList ref={ref} messages={transcript(4)} isLoading />);
    expect(scrollSpy.mock.calls.length).toBeGreaterThan(afterJump);
  });
});
