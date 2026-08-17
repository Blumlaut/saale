// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { CopyButton } from "@/components/chat/copy-button";

describe("CopyButton", () => {
  beforeEach(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("copies the text and shows a check icon (happy path)", async () => {
    const { container } = render(<CopyButton text="hello world" label="Copy response" />);
    const button = screen.getByRole("button", { name: "Copy response" });

    await act(async () => {
      fireEvent.click(button);
    });

    expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(1);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("hello world");
    // check icon replaces the copy icon
    expect(container.querySelector("svg.lucide-check")).not.toBeNull();
    expect(container.querySelector("svg.lucide-copy")).toBeNull();
  });

  it("logs the error and keeps the copy icon when the clipboard rejects (edge case)", async () => {
    vi.mocked(navigator.clipboard.writeText).mockRejectedValue(new Error("Permission denied"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { container } = render(<CopyButton text="hello" label="Copy response" />);
    const button = screen.getByRole("button", { name: "Copy response" });

    await act(async () => {
      fireEvent.click(button);
    });

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("hello");
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to copy text to clipboard"),
      expect.any(Error),
    );
    // no check icon on failure
    expect(container.querySelector("svg.lucide-check")).toBeNull();
    expect(container.querySelector("svg.lucide-copy")).not.toBeNull();
  });

  it("reverts to the copy icon after two seconds", async () => {
    vi.useFakeTimers();
    const { container } = render(<CopyButton text="hello" label="Copy response" />);
    const button = screen.getByRole("button", { name: "Copy response" });

    await act(async () => {
      fireEvent.click(button);
    });
    expect(container.querySelector("svg.lucide-check")).not.toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(container.querySelector("svg.lucide-check")).toBeNull();
    expect(container.querySelector("svg.lucide-copy")).not.toBeNull();
  });
});
