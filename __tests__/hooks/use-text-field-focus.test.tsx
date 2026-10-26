// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { renderHook, act, waitFor, cleanup } from "@testing-library/react";
import { useTextFieldFocus } from "@/hooks/use-text-field-focus";

/**
 * The shell hides the phone bottom bar while a text field has focus, because
 * that is when the keyboard is up. Only fields that raise a keyboard count.
 */

afterEach(cleanup);

function mountField(html: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.appendChild(host);
  return host.firstElementChild as HTMLElement;
}

describe("useTextFieldFocus", () => {
  it("reports typing into a textarea and stops once focus leaves it", async () => {
    const textarea = mountField("<textarea></textarea>");
    const button = mountField("<button>send</button>");
    const { result } = renderHook(() => useTextFieldFocus());

    expect(result.current).toBe(false);

    act(() => textarea.focus());
    expect(result.current).toBe(true);

    act(() => button.focus());
    await waitFor(() => expect(result.current).toBe(false));
  });

  it("tracks a search input", () => {
    const search = mountField('<input type="search" />');
    const { result } = renderHook(() => useTextFieldFocus());

    act(() => search.focus());

    expect(result.current).toBe(true);
  });

  it("ignores inputs that open no keyboard", () => {
    const checkbox = mountField('<input type="checkbox" />');
    const range = mountField('<input type="range" />');
    const { result } = renderHook(() => useTextFieldFocus());

    act(() => checkbox.focus());
    expect(result.current).toBe(false);

    act(() => range.focus());
    expect(result.current).toBe(false);
  });
});
