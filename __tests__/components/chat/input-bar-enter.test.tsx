// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, cleanup, fireEvent, act } from "@testing-library/react";
import { InputBar } from "@/components/chat/input-bar";

function stubPointer(coarse: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: coarse && query.includes("pointer: coarse"),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
}

function renderInputBar(value: string) {
  const onSend = vi.fn();
  const onValueChange = vi.fn();
  const utils = render(
    <InputBar
      onSend={onSend}
      value={value}
      onValueChange={onValueChange}
      isLoading={false}
      onStop={vi.fn()}
    />,
  );
  const textarea = utils.container.querySelector("textarea")!;
  return { onSend, onValueChange, textarea };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("InputBar Enter", () => {
  it("sends on Enter from a hardware keyboard", () => {
    stubPointer(false);
    const { onSend, textarea } = renderInputBar("hello");

    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(onSend).toHaveBeenCalledWith("hello", undefined);
  });

  it("keeps Enter a newline on a touch keyboard", () => {
    stubPointer(true);
    const { onSend, textarea } = renderInputBar("line one");

    let prevented: boolean | undefined;
    act(() => {
      const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
      textarea.dispatchEvent(event);
      prevented = event.defaultPrevented;
    });

    expect(onSend).not.toHaveBeenCalled();
    // Nothing cancelled the default, so the textarea takes the newline.
    expect(prevented).toBe(false);
  });

  it("sends from the send button on a touch keyboard", () => {
    stubPointer(true);
    const { onSend } = renderInputBar("two lines");

    const send = document.querySelector('button[aria-label="Send message"]')!;
    fireEvent.click(send);

    expect(onSend).toHaveBeenCalledWith("two lines", undefined);
  });
});
