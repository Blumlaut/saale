import { describe, it, expect } from "vitest";
import { titleWordOverlap } from "@/lib/queue/jobs/_helpers";

describe("titleWordOverlap", () => {
  it("returns 1 for identical titles", () => {
    expect(titleWordOverlap("hello world", "hello world")).toBe(1);
  });

  it("returns 0 for completely different titles", () => {
    expect(titleWordOverlap("hello world", "foo bar")).toBe(0);
  });

  it("returns 1 for identical titles with different case", () => {
    expect(titleWordOverlap("Hello World", "hello world")).toBe(1);
  });

  it("returns 0.5 when half the words match", () => {
    // "hello world" vs "hello foo" -> 1 match out of 2 in smaller set
    expect(titleWordOverlap("hello world", "hello foo")).toBe(0.5);
  });

  it("handles single word titles", () => {
    expect(titleWordOverlap("hello", "hello")).toBe(1);
    expect(titleWordOverlap("hello", "world")).toBe(0);
  });

  it("handles empty strings", () => {
    expect(titleWordOverlap("", "")).toBe(0);
    expect(titleWordOverlap("hello", "")).toBe(0);
    expect(titleWordOverlap("", "hello")).toBe(0);
  });

  it("handles extra whitespace", () => {
    expect(titleWordOverlap("  hello   world  ", "hello world")).toBe(1);
  });

  it("uses the smaller set as denominator", () => {
    // "a b c" vs "a b" -> 2 matches out of 2 (smaller set size) = 1.0
    expect(titleWordOverlap("a b c", "a b")).toBe(1);
    // "a b" vs "a b c" -> 2 matches out of 2 (smaller set size) = 1.0
    expect(titleWordOverlap("a b", "a b c")).toBe(1);
  });

  it("handles duplicate words in same title", () => {
    // "hello hello" is treated as set {"hello"} -> overlap with "hello world" is 1/1 = 1
    expect(titleWordOverlap("hello hello", "hello world")).toBe(1);
  });

  it("handles complex real-world titles", () => {
    expect(titleWordOverlap("Meeting with John", "Meeting with Jane")).toBeCloseTo(0.667);
    expect(titleWordOverlap("Project Alpha Update", "Project Beta Update")).toBeCloseTo(0.667);
  });

  it("returns 0 for whitespace-only strings", () => {
    expect(titleWordOverlap("   ", "hello")).toBe(0);
    expect(titleWordOverlap("   ", "   ")).toBe(0);
  });
});
