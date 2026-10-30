import { describe, it, expect } from "vitest";
import { appendTextChunk, appendedText, nextTextStep } from "@/lib/pi/streamed-text";

/**
 * The one shape a growing text field is streamed in: chunks while it grows, the
 * whole field on a slow cadence, and the client appends only where it belongs.
 */

describe("appendedText", () => {
  it("returns what a growing field gained", () => {
    expect(appendedText("", "thinking")).toBe("thinking");
    expect(appendedText("think", "thinking")).toBe("ing");
  });

  it("returns null when the field did not grow", () => {
    expect(appendedText("same", "same")).toBe(null);
    expect(appendedText("longer", "long")).toBe(null);
  });

  it("returns null when the field was rewritten", () => {
    // A retried or edited turn: there is no chunk, the whole field goes out.
    expect(appendedText("the first try", "a better second try")).toBe(null);
  });
});

describe("nextTextStep", () => {
  const step = (overrides: Partial<Parameters<typeof nextTextStep>[0]> = {}) =>
    nextTextStep({
      previous: "hello",
      next: "hello world",
      lastSnapshotAt: 1_000,
      now: 1_500,
      snapshotIntervalMs: 1_000,
      ...overrides,
    });

  it("sends the chunk while a snapshot is fresh enough", () => {
    expect(step()).toEqual({ kind: "delta", delta: " world", offset: 5 });
  });

  it("sends the whole field once the interval is up", () => {
    expect(step({ now: 2_000 })).toEqual({ kind: "snapshot", text: "hello world" });
  });

  it("sends the whole field on a field's very first step", () => {
    expect(step({ lastSnapshotAt: null, now: 0 })).toEqual({
      kind: "snapshot",
      text: "hello world",
    });
  });

  it("sends the whole field when the field no longer extends what was sent", () => {
    expect(step({ previous: "first try", next: "a better try" })).toEqual({
      kind: "snapshot",
      text: "a better try",
    });
  });

  it("says nothing when the field has nothing new", () => {
    expect(step({ next: "hello" })).toBe(null);
    expect(step({ previous: "", next: "" })).toBe(null);
  });
});

describe("appendTextChunk", () => {
  it("appends a chunk that continues what the client has", () => {
    expect(appendTextChunk("hello", " world", 5)).toBe("hello world");
    expect(appendTextChunk("", "hello", 0)).toBe("hello");
  });

  it("refuses a chunk from anywhere else", () => {
    // The client missed one (trimmed buffer, dropped event, a page load
    // mid-run). Splicing it in would garble the text.
    expect(appendTextChunk("hello", " world", 6)).toBe(null);
    expect(appendTextChunk("", "half a sentence", 12)).toBe(null);
  });
});
