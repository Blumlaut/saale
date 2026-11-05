import { describe, it, expect } from "vitest";
import { snippetAround } from "@/lib/search/snippet";

describe("snippetAround", () => {
  it("returns short text untouched", () => {
    expect(snippetAround("Invoice for March", "invoice", 200)).toBe("Invoice for March");
  });

  it("collapses whitespace so a wrapped body reads as prose", () => {
    expect(snippetAround("line one\n\n  line two", "line", 200)).toBe("line one line two");
  });

  it("shows the match when it sits deep in the body", () => {
    const body = `${"filler ".repeat(60)}the invoice for March${" tail".repeat(60)}`;
    const snippet = snippetAround(body, "invoice", 120);

    expect(snippet).toContain("invoice");
    expect(snippet.startsWith("…")).toBe(true);
    expect(snippet.endsWith("…")).toBe(true);
    expect(snippet.length).toBeLessThan(140);
  });

  it("does not mark a cut that never happened", () => {
    const snippet = snippetAround("a".repeat(500), "zzz", 100);
    expect(snippet.endsWith("…")).toBe(true);
    expect(snippet.startsWith("…")).toBe(false);
  });

  it("falls back to the head when no term is found in the window", () => {
    const body = `${"a".repeat(200)}invoice`;
    expect(snippetAround(body, "zzz", 50).startsWith("aaa")).toBe(true);
  });

  it("takes the earliest term when several match", () => {
    const body = `${"pad ".repeat(30)}bob ${"pad ".repeat(30)}invoice`;
    const snippet = snippetAround(body, "invoice bob", 80);
    expect(snippet).toContain("bob");
  });
});
