// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { MarkdownRenderer } from "@/components/chat/markdown-renderer";
import { MessageList } from "@/components/chat/message-list";
import type { Message } from "@/components/chat/types";

beforeAll(() => {
  // jsdom has no layout, so scrollIntoView does not exist.
  Element.prototype.scrollIntoView = vi.fn();
});

beforeEach(() => {
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("MarkdownRenderer code blocks", () => {
  const CODE_BLOCK = "```js\nconst x = 42;\nconsole.log(x);\n```";

  it("renders fenced code as a pre with a working copy button (happy path)", async () => {
    render(<MarkdownRenderer content={CODE_BLOCK} />);

    const pre = document.querySelector("pre");
    expect(pre).not.toBeNull();
    expect(pre!.textContent).toContain("const x = 42;");

    const button = screen.getByRole("button", { name: "Copy code" });
    await act(async () => {
      fireEvent.click(button);
    });
    expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(1);
    const copied = vi.mocked(navigator.clipboard.writeText).mock.calls[0]![0]!;
    expect(copied).toContain("const x = 42;");
    expect(copied).toContain("console.log(x);");
    // check icon replaces the copy icon
    expect(document.querySelector("svg.lucide-check")).not.toBeNull();
    expect(document.querySelector("svg.lucide-copy")).toBeNull();
  });

  it("logs the error and keeps the copy icon when the clipboard rejects (edge case)", async () => {
    vi.mocked(navigator.clipboard.writeText).mockRejectedValue(new Error("Permission denied"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<MarkdownRenderer content={CODE_BLOCK} />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
    });

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to copy code to clipboard"),
      expect.any(Error),
    );
    expect(document.querySelector("svg.lucide-check")).toBeNull();
    expect(document.querySelector("svg.lucide-copy")).not.toBeNull();
  });
});

describe("MarkdownRenderer line breaks", () => {
  const TWO_LINES = "first line\nsecond line";

  it("merges single newlines by default, as LLM markdown writes real structure", () => {
    const { container } = render(<MarkdownRenderer content={TWO_LINES} />);
    expect(container.querySelector("br")).toBeNull();
    expect((container.textContent ?? "").replace(/\s+/g, " ")).toContain("first line second line");
  });

  it("turns single newlines into breaks with hardBreaks, as typed chat input expects", () => {
    const { container } = render(<MarkdownRenderer content={TWO_LINES} hardBreaks />);
    expect(container.querySelector("br")).not.toBeNull();
  });

  it("hardBreaks still parses markdown syntax, not just line breaks", () => {
    const { container } = render(
      <MarkdownRenderer content={"**bold** word\n```js\ncode()\n```"} hardBreaks />,
    );
    expect(container.querySelector("strong")).not.toBeNull();
    expect(container.querySelector("pre")).not.toBeNull();
  });
});

describe("MessageList user messages", () => {
  function userMessage(content: string): Message[] {
    return [
      {
        id: "u1",
        role: "user",
        content,
        thinking: undefined,
        toolCalls: undefined,
        parentMessageId: undefined,
        createdAt: "2026-01-01T12:00:00.000Z",
        attachments: undefined,
      },
    ];
  }

  it("renders markdown in a user message instead of raw text (happy path)", () => {
    render(
      <MessageList
        messages={userMessage("check **this**\n\n```ts\nconst a: string = 'x';\n```")}
      />,
    );
    expect(screen.getByText("this").tagName).toBe("STRONG");
    const pre = document.querySelector("pre");
    expect(pre).not.toBeNull();
    expect(pre!.textContent).toContain("const a: string");
  });

  it("keeps plain multi-line user text on separate lines (edge case)", () => {
    render(<MessageList messages={userMessage("line one\nline two")} />);
    expect(document.querySelector("br")).not.toBeNull();
    // no code block for a message that has none
    expect(document.querySelector("pre")).toBeNull();
  });
});
