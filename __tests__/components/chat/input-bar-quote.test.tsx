// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, act, cleanup } from "@testing-library/react";
import { InputBar, type InputBarHandle } from "@/components/chat/input-bar";
import * as React from "react";

function Composer({
  value,
  onValueChange,
  ref,
}: {
  value: string;
  onValueChange: (v: string) => void;
  ref: React.Ref<InputBarHandle>;
}) {
  return (
    <InputBar
      ref={ref}
      onSend={vi.fn()}
      value={value}
      onValueChange={onValueChange}
      isLoading={false}
      onStop={vi.fn()}
    />
  );
}

function renderInputBar(value: string, onValueChange: (v: string) => void) {
  const ref = React.createRef<InputBarHandle>();
  const utils = render(<Composer value={value} onValueChange={onValueChange} ref={ref} />);
  const textarea = utils.container.querySelector("textarea")!;
  return { ref, textarea };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("InputBar insertQuote", () => {
  it("puts the blockquote in an empty composer and leaves the caret at the end", () => {
    const onValueChange = vi.fn();
    const { ref, textarea } = renderInputBar("", onValueChange);

    act(() => {
      ref.current!.insertQuote("hello world");
    });

    expect(onValueChange).toHaveBeenCalledTimes(1);
    expect(onValueChange).toHaveBeenCalledWith("> hello world\n");
    expect(textarea).toHaveFocus();
    expect(textarea.selectionStart).toBe("> hello world\n".length);
  });

  it("appends the quote after an existing draft with a blank-line separator", () => {
    const onValueChange = vi.fn();
    const { ref } = renderInputBar("fix this", onValueChange);

    act(() => {
      ref.current!.insertQuote("hello");
    });

    expect(onValueChange).toHaveBeenCalledWith("fix this\n\n> hello\n");
  });

  it("inserts at the caret when the composer is focused", () => {
    const onValueChange = vi.fn();
    const { ref, textarea } = renderInputBar("fix this", onValueChange);

    // Put the caret mid-word, focused.
    act(() => {
      textarea.focus();
    });
    textarea.setSelectionRange(4, 4);

    act(() => {
      ref.current!.insertQuote("hello");
    });

    expect(onValueChange).toHaveBeenCalledWith("fix \n\n> hello\n\nthis");
    expect(textarea.selectionStart).toBe(15); // start of "this"
  });

  it("handles a multi-line selection as a multi-line blockquote", () => {
    const onValueChange = vi.fn();
    const { ref } = renderInputBar("", onValueChange);

    act(() => {
      ref.current!.insertQuote("line one\nline two");
    });

    expect(onValueChange).toHaveBeenCalledWith("> line one\n> line two\n");
  });

  it("ignores a whitespace-only quote", () => {
    const onValueChange = vi.fn();
    const { ref } = renderInputBar("draft", onValueChange);

    act(() => {
      ref.current!.insertQuote("   \n");
    });

    expect(onValueChange).not.toHaveBeenCalled();
  });
});
