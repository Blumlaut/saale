import { describe, it, expect } from "vitest";
import { normalizeRunAt } from "@/lib/agent-jobs/schedule";

describe("normalizeRunAt", () => {
  it("parses an ISO 8601 string into a Date", () => {
    const parsed = normalizeRunAt("2026-05-01T15:30:00Z");
    expect(parsed).toBeInstanceOf(Date);
    expect(parsed?.toISOString()).toBe("2026-05-01T15:30:00.000Z");
  });

  it("passes an existing Date through", () => {
    const date = new Date("2026-05-01T15:30:00Z");
    expect(normalizeRunAt(date)).toBe(date);
  });

  it("treats null, undefined and empty string as unset", () => {
    expect(normalizeRunAt(null)).toBeNull();
    expect(normalizeRunAt(undefined)).toBeNull();
    expect(normalizeRunAt("")).toBeNull();
  });

  it("rejects an invalid date string", () => {
    expect(() => normalizeRunAt("not-a-date")).toThrow(/Invalid runAt/);
  });

  it("rejects an invalid Date instance", () => {
    expect(() => normalizeRunAt(new Date("nope"))).toThrow(/Invalid runAt/);
  });

  it("rejects non-string, non-Date values", () => {
    expect(() => normalizeRunAt(1234)).toThrow(/ISO 8601/);
    expect(() => normalizeRunAt({ at: "later" })).toThrow(/ISO 8601/);
  });
});
