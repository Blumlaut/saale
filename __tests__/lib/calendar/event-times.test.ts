import { describe, it, expect } from "vitest";
import {
  defaultEventEnd,
  resolveEventTimeUpdate,
  resolveNewEventTimes,
} from "@/lib/calendar/event-times";

describe("resolveNewEventTimes", () => {
  it("anchors wall-clock times in the given timezone", () => {
    const times = resolveNewEventTimes({
      dtStart: "2026-01-15T09:00:00",
      dtEnd: "2026-01-15T10:30:00",
      timeZone: "Europe/Athens",
    });

    expect(times.dtStart.toISOString()).toBe("2026-01-15T07:00:00.000Z");
    expect(times.dtEnd?.toISOString()).toBe("2026-01-15T08:30:00.000Z");
    expect(times.timeZone).toBe("Europe/Athens");
  });

  it("keeps an absolute value and only stores the timezone as a label", () => {
    const times = resolveNewEventTimes({
      dtStart: "2026-01-15T09:00:00Z",
      timeZone: "Europe/Athens",
    });

    expect(times.dtStart.toISOString()).toBe("2026-01-15T09:00:00.000Z");
    expect(times.timeZone).toBe("Europe/Athens");
  });

  it("defaults to UTC when no timezone is given", () => {
    const times = resolveNewEventTimes({ dtStart: "2026-01-15T09:00:00" });

    expect(times.dtStart.toISOString()).toBe("2026-01-15T09:00:00.000Z");
    expect(times.dtEnd).toBeNull();
    expect(times.timeZone).toBeNull();
  });

  it("stores all-day events as UTC dates", () => {
    const times = resolveNewEventTimes({
      dtStart: "2026-01-15",
      dtEnd: "2026-01-16",
      timeZone: "America/New_York",
      allDay: true,
    });

    expect(times.dtStart.toISOString()).toBe("2026-01-15T00:00:00.000Z");
    expect(times.dtEnd?.toISOString()).toBe("2026-01-16T00:00:00.000Z");
  });

  it("rejects an unknown timezone and never stores it", () => {
    expect(() =>
      resolveNewEventTimes({ dtStart: "2026-01-15T09:00:00", timeZone: "Europe/Athenz" }),
    ).toThrow(/Unknown timezone/);
  });

  it("rejects an unparseable start", () => {
    expect(() => resolveNewEventTimes({ dtStart: "next tuesday" })).toThrow(/Invalid datetime/);
  });
});

describe("resolveEventTimeUpdate", () => {
  const current = {
    dtStart: new Date("2026-01-15T07:00:00.000Z"), // 09:00 in Athens
    dtEnd: new Date("2026-01-15T08:00:00.000Z"),
    timeZone: "Europe/Athens",
    allDay: false,
  };

  it("anchors a new wall-clock start in the event's timezone", () => {
    const update = resolveEventTimeUpdate(current, { dtStart: "2026-01-15T12:00:00" });

    expect(update.dtStart?.toISOString()).toBe("2026-01-15T10:00:00.000Z");
    expect(update.timeZone).toBeUndefined();
  });

  it("anchors a new start in a newly supplied timezone", () => {
    const update = resolveEventTimeUpdate(current, {
      dtStart: "2026-01-15T12:00:00",
      timeZone: "Asia/Tokyo",
    });

    expect(update.dtStart?.toISOString()).toBe("2026-01-15T03:00:00.000Z");
    expect(update.timeZone).toBe("Asia/Tokyo");
  });

  it("keeps the local time and duration when only the timezone changes", () => {
    const update = resolveEventTimeUpdate(current, { timeZone: "Asia/Tokyo" });

    expect(update.timeZone).toBe("Asia/Tokyo");
    expect(update.dtStart?.toISOString()).toBe("2026-01-15T00:00:00.000Z"); // 09:00 Tokyo
    expect(update.dtEnd?.toISOString()).toBe("2026-01-15T01:00:00.000Z"); // still one hour
  });

  it("clears the timezone without moving the event", () => {
    const update = resolveEventTimeUpdate(current, { timeZone: null });

    expect(update.timeZone).toBeNull();
    expect(update.dtStart).toBeUndefined();
    expect(update.dtEnd).toBeUndefined();
  });

  it("leaves untouched fields alone", () => {
    const update = resolveEventTimeUpdate(current, { dtEnd: null });

    expect(update.dtEnd).toBeNull();
    expect(update.dtStart).toBeUndefined();
    expect(update.timeZone).toBeUndefined();
  });

  it("moves an event that had no timezone yet onto one", () => {
    const naive = { ...current, timeZone: null };
    const update = resolveEventTimeUpdate(naive, { timeZone: "Europe/Athens" });

    // Stored UTC wall clock 07:00 becomes 07:00 Athens.
    expect(update.dtStart?.toISOString()).toBe("2026-01-15T05:00:00.000Z");
    expect(update.dtEnd?.toISOString()).toBe("2026-01-15T06:00:00.000Z");
  });

  it("does not re-anchor when the timezone is passed unchanged", () => {
    const update = resolveEventTimeUpdate(current, { timeZone: "Europe/Athens" });

    expect(update.timeZone).toBe("Europe/Athens");
    expect(update.dtStart).toBeUndefined();
  });

  it("rejects an unknown timezone", () => {
    expect(() => resolveEventTimeUpdate(current, { timeZone: "CEST" })).toThrow(/Unknown timezone/);
  });

  it("anchors all-day updates as UTC dates", () => {
    const update = resolveEventTimeUpdate(
      { dtStart: new Date("2026-01-15T00:00:00.000Z"), dtEnd: null, timeZone: null, allDay: false },
      { dtStart: "2026-01-20", allDay: true, timeZone: "Asia/Tokyo" },
    );

    expect(update.dtStart?.toISOString()).toBe("2026-01-20T00:00:00.000Z");
  });
});

describe("defaultEventEnd", () => {
  it("adds one hour", () => {
    expect(defaultEventEnd(new Date("2026-01-15T07:00:00.000Z")).toISOString()).toBe(
      "2026-01-15T08:00:00.000Z",
    );
  });
});
