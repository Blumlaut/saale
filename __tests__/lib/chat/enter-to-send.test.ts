// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { isSendKey } from "@/lib/chat/enter-to-send";

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

function keyDown(init: KeyboardEventInit & { composing?: boolean }) {
  const event = new KeyboardEvent("keydown", init);
  if (init.composing) {
    Object.defineProperty(event, "isComposing", { value: true });
  }
  // The components hand React's synthetic event to the helper.
  return { key: event.key, shiftKey: event.shiftKey, nativeEvent: event } as never;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isSendKey", () => {
  it("submits on Enter from a hardware keyboard", () => {
    stubPointer(false);
    expect(isSendKey(keyDown({ key: "Enter" }))).toBe(true);
  });

  it("leaves Enter to the newline on a touch keyboard", () => {
    stubPointer(true);
    expect(isSendKey(keyDown({ key: "Enter" }))).toBe(false);
  });

  it("ignores Shift+Enter and other keys", () => {
    stubPointer(false);
    expect(isSendKey(keyDown({ key: "Enter", shiftKey: true }))).toBe(false);
    expect(isSendKey(keyDown({ key: "a" }))).toBe(false);
  });

  it("ignores the Enter that confirms an IME candidate", () => {
    stubPointer(false);
    expect(isSendKey(keyDown({ key: "Enter", composing: true }))).toBe(false);
  });
});
