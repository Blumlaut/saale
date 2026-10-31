// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { useOnResume } from "@/hooks/use-on-resume";

/**
 * What a page has to know when it comes back: how long it was away. A phone
 * suspends an installed app, and everything the page held open across it comes
 * back stale, so the caller decides between a cheap refetch and a reconnect.
 */

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
}

function Probe({ onResume }: { onResume: (hiddenForMs: number) => void }) {
  useOnResume(onResume);
  return null;
}

describe("useOnResume", () => {
  beforeEach(() => {
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports how long the page was hidden", () => {
    const onResume = vi.fn();
    render(<Probe onResume={onResume} />);

    act(() => setVisibility("hidden"));
    vi.advanceTimersByTime(30_000);
    act(() => setVisibility("visible"));

    expect(onResume).toHaveBeenCalledTimes(1);
    expect(onResume).toHaveBeenCalledWith(30_000);
  });

  it("does not fire while the page stays hidden", () => {
    const onResume = vi.fn();
    render(<Probe onResume={onResume} />);

    act(() => setVisibility("hidden"));
    vi.advanceTimersByTime(60_000);

    expect(onResume).not.toHaveBeenCalled();
  });

  it("reports no hidden time when the first change is to visible", () => {
    const onResume = vi.fn();
    render(<Probe onResume={onResume} />);

    act(() => setVisibility("visible"));

    expect(onResume).toHaveBeenCalledWith(0);
  });

  it("stops listening once unmounted", () => {
    const onResume = vi.fn();
    const { unmount } = render(<Probe onResume={onResume} />);

    unmount();
    act(() => {
      setVisibility("hidden");
      setVisibility("visible");
    });

    expect(onResume).not.toHaveBeenCalled();
  });

  it("calls the latest callback without resubscribing", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(<Probe onResume={first} />);

    rerender(<Probe onResume={second} />);
    act(() => setVisibility("hidden"));
    vi.advanceTimersByTime(1_000);
    act(() => setVisibility("visible"));

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith(1_000);
  });
});
