import { describe, it, expect } from "vitest";
import { buildQuoteBlock, insertQuote } from "@/lib/chat/quote-insert";

describe("buildQuoteBlock", () => {
  it("wraps a single line in a blockquote (happy path)", () => {
    expect(buildQuoteBlock("hello")).toBe("> hello");
  });

  it("prefixes every line of a multi-line selection, keeping blank lines", () => {
    expect(buildQuoteBlock("line one\nline two")).toBe("> line one\n> line two");
    expect(buildQuoteBlock("a\n\nb")).toBe("> a\n>\n> b");
  });

  it("trims surrounding whitespace from the selection", () => {
    expect(buildQuoteBlock("  \nhello\n  ")).toBe("> hello");
  });

  it("returns an empty string for empty or whitespace-only input", () => {
    expect(buildQuoteBlock("")).toBe("");
    expect(buildQuoteBlock("   \n\t ")).toBe("");
  });
});

describe("insertQuote", () => {
  it("puts the quote plus a newline in an empty draft (happy path)", () => {
    // Single trailing newline: the caret starts on the line after the quote,
    // ready for the question.
    const result = insertQuote("", "hello", 0);
    expect(result.value).toBe("> hello\n");
    expect(result.cursor).toBe(result.value.length);
  });

  it("appends the quote at the end of a non-empty draft", () => {
    const result = insertQuote("fix this", "hello", 8);
    expect(result.value).toBe("fix this\n\n> hello\n");
    // Caret sits after the trailing newline  ready for the question.
    expect(result.cursor).toBe(result.value.length);
  });

  it("inserts at a mid-line caret with blank lines on both sides", () => {
    const result = insertQuote("abcdef", "q", 3);
    expect(result.value).toBe("abc\n\n> q\n\ndef");
    expect(result.cursor).toBe(10); // start of "def"
  });

  it("inserts at a line-start caret without duplicating the blank line", () => {
    const result = insertQuote("line1\nline2", "q", 5);
    expect(result.value).toBe("line1\n\n> q\n\nline2");
    expect(result.cursor).toBe(11); // start of "line2"
  });

  it("does not add a separator when one already exists around the caret", () => {
    // before ends with a blank line
    expect(insertQuote("text\n\ntail", "q", 6).value).toBe("text\n\n> q\n\ntail");
    // after starts with a blank line
    expect(insertQuote("text\n\ntail", "q", 4).value).toBe("text\n\n> q\n\ntail");
  });

  it("inserts a multi-line quote as a multi-line blockquote", () => {
    const result = insertQuote("", "a\nb", 0);
    expect(result.value).toBe("> a\n> b\n");
    expect(result.cursor).toBe(result.value.length);
  });

  it("leaves the draft untouched for a whitespace-only quote", () => {
    const result = insertQuote("draft", "   \n", 2);
    expect(result.value).toBe("draft");
    expect(result.cursor).toBe(2);
  });

  it("clamps out-of-range cursorts to the draft bounds", () => {
    expect(insertQuote("ab", "q", 999).value).toBe("ab\n\n> q\n");
    expect(insertQuote("ab", "q", -10).value).toBe("> q\n\nab");
  });
});
