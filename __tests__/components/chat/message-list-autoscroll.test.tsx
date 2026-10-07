// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { createRef } from "react";
import { act, render, screen, fireEvent } from "@testing-library/react";
import { MessageList, type MessageListHandle } from "@/components/chat/message-list";
import type { Message } from "@/components/chat/types";

/**
 * Auto-scroll: the list follows the tail while armed; scrolling up disarms it
 * (so reading history survives reloads and streaming); the jump-to-bottom
 * button and the imperative handle re-arm it and jump to the tail.
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

/** Give the scroller a fake 500px viewport over `scrollHeight` px of content. */
function setScroll(container: HTMLElement, scrollTop: number, scrollHeight = 5000): HTMLElement {
  const scroller = scrollerOf(container);
  Object.defineProperty(scroller, "scrollHeight", { value: scrollHeight, configurable: true });
  Object.defineProperty(scroller, "clientHeight", { value: 500, configurable: true });
  scroller.scrollTop = scrollTop;
  return scroller;
}

/** Fake a viewport scrolled away from the tail and fire the scroll event. */
function scrollUp(container: HTMLElement) {
  fireEvent.scroll(setScroll(container, 0));
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
    const { rerender } = render(<MessageList messages={transcript(2)} isLoading />);
    const afterMount = scrollSpy.mock.calls.length;
    expect(afterMount).toBeGreaterThan(0);

    rerender(<MessageList messages={transcript(3)} isLoading />);
    expect(scrollSpy.mock.calls.length).toBeGreaterThan(afterMount);
  });

  it("stops following when the user scrolls up, even while streaming", () => {
    const { container, rerender } = render(<MessageList messages={transcript(2)} isLoading />);
    scrollUp(container);
    const afterScrollUp = scrollSpy.mock.calls.length;

    rerender(<MessageList messages={transcript(4)} isLoading />);
    expect(scrollSpy.mock.calls.length).toBe(afterScrollUp);
  });

  it("stops following the moment the user scrolls up mid-stream, not at the end", () => {
    const { container, rerender } = render(<MessageList messages={transcript(2)} isLoading />);
    const scroller = setScroll(container, 4500);
    fireEvent.scroll(scroller);
    const armed = scrollSpy.mock.calls.length;

    fireEvent.wheel(scroller, { deltaY: -120 });

    rerender(<MessageList messages={transcript(4)} isLoading />);
    expect(scrollSpy.mock.calls.length).toBe(armed);
  });

  it("keeps following when the wheel points at the tail", () => {
    const { container, rerender } = render(<MessageList messages={transcript(2)} isLoading />);
    const scroller = setScroll(container, 4500);
    fireEvent.scroll(scroller);
    const armed = scrollSpy.mock.calls.length;

    fireEvent.wheel(scroller, { deltaY: 120 });

    rerender(<MessageList messages={transcript(4)} isLoading />);
    expect(scrollSpy.mock.calls.length).toBeGreaterThan(armed);
  });

  it("stays armed when a wheel has nothing to scroll (short transcript)", () => {
    const { container, rerender } = render(<MessageList messages={transcript(2)} isLoading />);
    const scroller = setScroll(container, 0, 500);
    fireEvent.scroll(scroller);
    const armed = scrollSpy.mock.calls.length;

    fireEvent.wheel(scroller, { deltaY: -120 });

    rerender(<MessageList messages={transcript(4)} isLoading />);
    expect(scrollSpy.mock.calls.length).toBeGreaterThan(armed);
  });

  it("never overrides a position the user moved without a scroll event yet", () => {
    const { container, rerender } = render(<MessageList messages={transcript(2)} isLoading />);
    const scroller = setScroll(container, 4500);
    fireEvent.scroll(scroller);
    const armed = scrollSpy.mock.calls.length;

    // A scrollbar drag: the position moved, the scroll event is still pending.
    scroller.scrollTop = 900;

    rerender(<MessageList messages={transcript(4)} isLoading />);
    expect(scrollSpy.mock.calls.length).toBe(armed);

    // Disarmed for good, the way a delivered scroll event would leave it.
    rerender(<MessageList messages={transcript(5)} isLoading />);
    expect(scrollSpy.mock.calls.length).toBe(armed);
  });

  it("follows again once the user scrolls back down to the tail", () => {
    const { container, rerender } = render(<MessageList messages={transcript(3)} isLoading />);
    scrollUp(container);

    fireEvent.scroll(setScroll(container, 4500));
    const rearmed = scrollSpy.mock.calls.length;

    rerender(<MessageList messages={transcript(4)} isLoading />);
    expect(scrollSpy.mock.calls.length).toBeGreaterThan(rearmed);
  });

  it("hides the jump button at the bottom and shows it while reading history", () => {
    const { container } = render(<MessageList messages={transcript(5)} />);
    expect(jumpButton()).not.toBeInTheDocument();

    scrollUp(container);
    expect(jumpButton()).toBeInTheDocument();
  });

  it("jumps to the bottom and re-arms auto-scroll when the button is used", () => {
    const { container, rerender } = render(<MessageList messages={transcript(3)} isLoading />);
    scrollUp(container);
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
    scrollUp(container);
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
