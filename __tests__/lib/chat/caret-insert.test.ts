import { describe, expect, it } from "vitest";
import { insertAtCaret } from "@/lib/chat/caret-insert";

describe("insertAtCaret", () => {
  it("fills an empty draft", () => {
    expect(insertAtCaret("", "hello there", 0)).toBe("hello there");
  });

  it("appends after a draft that already has text", () => {
    expect(insertAtCaret("fix the test", "then ship it", 12)).toBe("fix the test then ship it");
  });

  it("goes where the caret is, mid-sentence", () => {
    expect(insertAtCaret("send it now", "to Alice", 7)).toBe("send it to Alice now");
  });

  it("does not double the space next to existing whitespace", () => {
    expect(insertAtCaret("fix the test ", "then ship it", 13)).toBe("fix the test then ship it");
    expect(insertAtCaret("fix the", " now", 7)).toBe("fix the now");
  });

  it("leaves the draft alone for a silent transcript", () => {
    expect(insertAtCaret("unchanged", "   ", 9)).toBe("unchanged");
  });

  it("clamps a caret past the end of the draft", () => {
    expect(insertAtCaret("abc", "def", 99)).toBe("abc def");
  });
});
