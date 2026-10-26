import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { formatRelativeDate } from "@/lib/format";

const NOW = new Date("2026-03-15T12:00:00Z").getTime();

const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe("formatRelativeDate", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("calls the first two minutes just now", () => {
    expect(formatRelativeDate(ago(0))).toBe("just now");
    expect(formatRelativeDate(ago(119_000))).toBe("just now");
  });

  it("counts the minutes after that", () => {
    expect(formatRelativeDate(ago(2 * 60_000))).toBe("2m ago");
    expect(formatRelativeDate(ago(38 * 60_000))).toBe("38m ago");
    expect(formatRelativeDate(ago(59 * 60_000))).toBe("59m ago");
  });

  it("moves on to hours, days and dates", () => {
    expect(formatRelativeDate(ago(60 * 60_000))).toBe("1h ago");
    expect(formatRelativeDate(ago(23.5 * 60 * 60_000))).toBe("23h ago");
    expect(formatRelativeDate(ago(30 * 60 * 60_000))).toBe("yesterday");
    expect(formatRelativeDate(ago(3 * 24 * 60 * 60_000))).toBe("3d ago");
    expect(formatRelativeDate(ago(30 * 24 * 60 * 60_000))).toBe("Feb 13");
  });

  it("returns an empty string for a date it cannot read", () => {
    expect(formatRelativeDate("not a date")).toBe("");
  });
});
