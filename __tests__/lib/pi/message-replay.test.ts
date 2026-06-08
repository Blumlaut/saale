import { describe, it, expect } from "vitest";
import { normalizeToolResult } from "@/lib/pi/message-replay";

describe("normalizeToolResult", () => {
  it("extracts text from structured tool result", () => {
    const result = { content: [{ type: "text", text: "hello world" }] };
    expect(normalizeToolResult(result)).toBe("hello world");
  });

  it("returns string as-is", () => {
    expect(normalizeToolResult("already a string")).toBe("already a string");
  });

  it("extracts text from multi-block result", () => {
    const result = {
      content: [
        { type: "text", text: "first" },
        { type: "image", data: "..." },
        { type: "text", text: "second" },
      ],
    };
    expect(normalizeToolResult(result)).toBe("firstsecond");
  });

  it("skips non-text content blocks", () => {
    const result = {
      content: [
        { type: "image", data: "..." },
        { type: "json", value: { foo: "bar" } },
      ],
    };
    expect(normalizeToolResult(result)).toBe("");
  });

  it("falls back to JSON.stringify for unexpected shapes", () => {
    expect(normalizeToolResult({ foo: 42 })).toBe('{"foo":42}');
    expect(normalizeToolResult(null)).toBe("null");
    expect(normalizeToolResult(42)).toBe("42");
  });

  it("handles empty content array", () => {
    const result = { content: [] };
    expect(normalizeToolResult(result)).toBe("");
  });

  it("handles missing text field", () => {
    const result = { content: [{ type: "text" }] };
    expect(normalizeToolResult(result)).toBe("");
  });

  it("handles null text field", () => {
    const result = { content: [{ type: "text", text: null }] };
    expect(normalizeToolResult(result)).toBe("");
  });
});
