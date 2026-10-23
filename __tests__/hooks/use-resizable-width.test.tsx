// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useResizableWidth, type ResizableWidthOptions } from "@/hooks/use-resizable-width";

/**
 * The drag handle that sets a column's width.
 *
 * Pointer capture is what keeps a drag alive past the handle, and the clamp is
 * what stops a drag from collapsing the column or pushing it off screen.
 */

const BASE: ResizableWidthOptions = {
  storageKey: "test.panelWidth",
  label: "Resize the panel",
  defaultWidth: 320,
  minWidth: 280,
  maxWidth: 720,
  handle: "left",
};

function Panel(options: Partial<ResizableWidthOptions>) {
  const panel = useResizableWidth({ ...BASE, ...options });
  return (
    <div>
      <div data-testid="handle" {...panel.handleProps} />
      <output data-testid="width">{panel.width}</output>
      <output data-testid="dragging">{String(panel.dragging)}</output>
    </div>
  );
}

function width(): number {
  return Number(screen.getByTestId("width").textContent);
}

function drag(from: number, to: number, pointerId = 1): void {
  const handle = screen.getByTestId("handle");
  fireEvent.pointerDown(handle, { clientX: from, pointerId, button: 0 });
  fireEvent.pointerMove(handle, { clientX: to, pointerId });
  fireEvent.pointerUp(handle, { clientX: to, pointerId });
}

beforeEach(() => {
  window.localStorage.clear();
  // jsdom has neither pointer capture nor a PointerEvent to feed the handlers.
  class TestPointerEvent extends MouseEvent {
    readonly pointerId: number;
    constructor(type: string, init: MouseEventInit & { pointerId?: number } = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 1;
    }
  }
  vi.stubGlobal("PointerEvent", TestPointerEvent);
  HTMLElement.prototype.setPointerCapture = vi.fn();
  HTMLElement.prototype.hasPointerCapture = vi.fn(() => true);
  HTMLElement.prototype.releasePointerCapture = vi.fn();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useResizableWidth", () => {
  it("widens as a left-edge handle is pulled left, and keeps the width", async () => {
    render(<Panel />);
    await waitFor(() => expect(width()).toBe(320));

    drag(620, 500);

    expect(width()).toBe(440);
    expect(screen.getByTestId("dragging").textContent).toBe("false");
    expect(window.localStorage.getItem("test.panelWidth")).toBe("440");
  });

  it("follows the pointer for a handle on the panel's right edge", async () => {
    render(<Panel handle="right" />);
    await waitFor(() => expect(width()).toBe(320));

    // A right-edge handle belongs to a left column, which widens as it is pulled right.
    drag(500, 600);

    expect(width()).toBe(420);
  });

  it("clamps a drag to the column's limits", async () => {
    render(<Panel />);
    await waitFor(() => expect(width()).toBe(320));

    drag(500, -5000);
    expect(width()).toBe(720);

    drag(500, 5000);
    expect(width()).toBe(280);
  });

  it("restores the stored width, not the default", async () => {
    window.localStorage.setItem("test.panelWidth", "512");

    render(<Panel />);

    await waitFor(() => expect(width()).toBe(512));
  });

  it("ignores a stored width outside the limits", async () => {
    window.localStorage.setItem("test.panelWidth", "4000");

    render(<Panel />);

    await waitFor(() => expect(width()).toBe(720));
  });

  it("moves the edge with the arrow keys", async () => {
    render(<Panel />);
    await waitFor(() => expect(width()).toBe(320));
    const handle = screen.getByTestId("handle");

    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(width()).toBe(344);

    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(width()).toBe(320);
    expect(window.localStorage.getItem("test.panelWidth")).toBe("320");
  });

  it("ignores a right-click", async () => {
    render(<Panel />);
    await waitFor(() => expect(width()).toBe(320));
    const handle = screen.getByTestId("handle");

    fireEvent.pointerDown(handle, { clientX: 500, pointerId: 1, button: 2 });
    fireEvent.pointerMove(handle, { clientX: 620, pointerId: 1 });

    expect(width()).toBe(320);
  });
});
