// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import { useRef } from "react";
import { SelectionQuoteButton } from "@/components/chat/selection-quote-button";

// jsdom does not implement Range.getBoundingClientRect  browsers always
// do. The button only needs *some* rect to compute its (unasserted) offset.
Range.prototype.getBoundingClientRect = function () {
  return {
    top: 10,
    bottom: 22,
    left: 50,
    right: 100,
    width: 50,
    height: 12,
    x: 50,
    y: 10,
    toJSON: () => ({}),
  } as DOMRect;
};

/**
 * jsdom never dispatches `selectionchange` on its own (browsers do), so the
 * tests dispatch it explicitly after changing the selection.
 */
function selectText(el: Element, start: number, end: number) {
  const node = el.firstChild;
  if (node === null || node.nodeType !== Node.TEXT_NODE) throw new Error("expected a text node");
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
  act(() => {
    document.dispatchEvent(new Event("selectionchange"));
  });
}

function clearSelection() {
  act(() => {
    window.getSelection()?.removeAllRanges();
    document.dispatchEvent(new Event("selectionchange"));
  });
}

function Harness({ onQuote }: { onQuote: (text: string) => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  return (
    <div ref={containerRef} className="relative">
      <div data-quoteable>
        <span id="message-text">The quick brown fox</span>
      </div>
      <div id="outside">10:42</div>
      <SelectionQuoteButton containerRef={containerRef} onQuote={onQuote} version={0} />
    </div>
  );
}

function renderHarness(onQuote: (text: string) => void) {
  return render(<Harness onQuote={onQuote} />);
}

describe("SelectionQuoteButton", () => {
  beforeEach(() => {
    clearSelection();
  });

  afterEach(() => {
    cleanup();
    clearSelection();
    vi.restoreAllMocks();
  });

  it("appears when text inside a quoteable bubble is selected (happy path)", () => {
    const onQuote = vi.fn();
    renderHarness(onQuote);
    const message = document.getElementById("message-text")!;

    selectText(message, 4, 9); // "quick"

    const button = screen.getByRole("button", { name: "Quote selection into your reply" });
    expect(button).toHaveClass("opacity-100");
    expect(button).toHaveClass("pointer-events-auto");
    expect(button).not.toHaveAttribute("aria-hidden");
    expect(button).toHaveAttribute("tabindex", "0");

    fireEvent.click(button);
    expect(onQuote).toHaveBeenCalledTimes(1);
    expect(onQuote).toHaveBeenCalledWith("quick");
  });

  it("hides for a selection outside quoteable content", () => {
    const { container } = renderHarness(vi.fn());
    const outside = document.getElementById("outside")!;

    selectText(outside, 0, 5);

    // aria-hidden keeps it out of the a11y tree, so query the DOM directly.
    const button = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Quote selection into your reply"]',
    )!;
    expect(button).toHaveClass("opacity-0");
    expect(button).toHaveClass("pointer-events-none");
    // Hidden must be invisible to a11y tree and unfocusable (opacity alone
    // would keep it in the tab order).
    expect(button).toHaveAttribute("aria-hidden", "true");
    expect(button).toHaveAttribute("tabindex", "-1");
  });

  it("hides for a selection crossing a quoteable boundary", () => {
    const { container } = renderHarness(vi.fn());
    const message = document.getElementById("message-text")!;
    const outside = document.getElementById("outside")!;

    // A range spanning both bubbles would mix content with the timestamp.
    const range = document.createRange();
    range.setStart(message.firstChild!, 0);
    range.setEnd(outside.firstChild!, 3);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    act(() => {
      document.dispatchEvent(new Event("selectionchange"));
    });

    const button = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Quote selection into your reply"]',
    )!;
    expect(button).toHaveClass("opacity-0");
  });

  it("hides for a collapsed selection", () => {
    const { container } = renderHarness(vi.fn());
    const message = document.getElementById("message-text")!;
    const button = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Quote selection into your reply"]',
    )!;

    selectText(message, 4, 4); // collapsed
    expect(button).toHaveClass("opacity-0");
  });

  it("hides for a whitespace-only selection", () => {
    const { container } = renderHarness(vi.fn());
    const button = container.querySelector('button[aria-label="Quote selection into your reply"]')!;

    // Selecting a run of spaces inside a bubble quotes nothing.
    const whitespace = document.createElement("span");
    whitespace.textContent = "   ";
    container.querySelector("[data-quoteable]")!.appendChild(whitespace);
    selectText(whitespace, 0, 3);
    expect(button).toHaveClass("opacity-0");
  });

  it("places the button at the selection's viewport offset, not the content offset", () => {
    const { container } = renderHarness(vi.fn());
    const scroller = container.firstElementChild as HTMLElement;
    // The transcript is scrolled: the button must track where the selection
    // is *on screen*, not where it sits in the scrollable content.
    scroller.scrollTop = 500;
    const message = document.getElementById("message-text")!;

    selectText(message, 4, 9); // "quick"

    const button = screen.getByRole("button", { name: "Quote selection into your reply" });
    // Mocked range rect: top 10, bottom 22 (container bounds are 0). Below-
    // placement: 22 + GAP. A content-offset calculation would report 528 here.
    expect(button.style.top).toBe("28px");
  });

  it("clamps the button inside the container's visible area", () => {
    const { container } = renderHarness(vi.fn());
    const scroller = container.firstElementChild as HTMLElement;
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 30 });
    const message = document.getElementById("message-text")!;

    selectText(message, 4, 9);

    const button = screen.getByRole("button", { name: "Quote selection into your reply" });
    // Below-placement (28px) would hang off the 30px-tall panel  clamp it in.
    expect(button.style.top).toBe("6px");
  });

  it("keeps the button at the selection's spot while it fades out (no corner flash)", () => {
    renderHarness(vi.fn());
    const message = document.getElementById("message-text")!;

    selectText(message, 4, 9);
    const button = screen.getByRole("button", { name: "Quote selection into your reply" });
    const topWhileVisible = button.style.top;
    expect(topWhileVisible).toBe("28px");

    clearSelection();

    // Hidden, but still at the selection's spot: the opacity transition must
    // fade in place, not from the top-left corner.
    expect(button).toHaveClass("opacity-0");
    expect(button.style.top).toBe(topWhileVisible);
  });

  it("quotes the selection with the keyboard shortcut (Ctrl+Shift+Q)", () => {
    const onQuote = vi.fn();
    renderHarness(onQuote);
    const message = document.getElementById("message-text")!;

    selectText(message, 10, 15); // "brown"
    fireEvent.keyDown(window, { key: "q", ctrlKey: true, shiftKey: true });
    expect(onQuote).toHaveBeenCalledTimes(1);
    expect(onQuote).toHaveBeenCalledWith("brown");

    // Plain Q or Shift+Q without the modifier must not trigger.
    onQuote.mockClear();
    fireEvent.keyDown(window, { key: "q", shiftKey: true });
    fireEvent.keyDown(window, { key: "q" });
    expect(onQuote).not.toHaveBeenCalled();
  });
});
