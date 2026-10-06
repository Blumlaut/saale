import { describe, it, expect, afterEach, vi } from "vitest";
import { parseICS } from "@/lib/calendar/ics-import";

const originalTimeZone = process.env.TZ;

afterEach(() => {
  process.env.TZ = originalTimeZone;
  vi.restoreAllMocks();
});

/** Wrap VEVENT lines into a minimal ICS document. */
function ics(...lines: string[]): string {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "BEGIN:VEVENT",
    ...lines,
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
}

const TZID_EVENT = ics(
  "UID:tzid-1@example.com",
  "SUMMARY:Standup",
  "DTSTART;TZID=Europe/Athens:20260115T090000",
  "DTEND;TZID=Europe/Athens:20260115T100000",
);

describe("parseICS timezone anchoring", () => {
  it("anchors a TZID event on the real instant instead of storing its wall clock as UTC", () => {
    const [event] = parseICS(TZID_EVENT);

    expect(event?.dtStart.toISOString()).toBe("2026-01-15T07:00:00.000Z");
    expect(event?.dtEnd?.toISOString()).toBe("2026-01-15T08:00:00.000Z");
    expect(event?.timeZone).toBe("Europe/Athens");
  });

  it("uses the offset in force on the event date", () => {
    const [event] = parseICS(
      ics("UID:summer@example.com", "DTSTART;TZID=Europe/Athens:20260715T090000"),
    );

    expect(event?.dtStart.toISOString()).toBe("2026-07-15T06:00:00.000Z");
  });

  it("produces the same instants whatever timezone the machine runs in", () => {
    const results = ["UTC", "Europe/Athens", "America/New_York"].map((timeZone) => {
      process.env.TZ = timeZone;
      const [event] = parseICS(TZID_EVENT);
      return `${event?.dtStart.toISOString()}|${event?.dtEnd?.toISOString()}`;
    });

    expect(results).toEqual([
      "2026-01-15T07:00:00.000Z|2026-01-15T08:00:00.000Z",
      "2026-01-15T07:00:00.000Z|2026-01-15T08:00:00.000Z",
      "2026-01-15T07:00:00.000Z|2026-01-15T08:00:00.000Z",
    ]);
  });

  it("keeps UTC values absolute and leaves the timezone empty", () => {
    const [event] = parseICS(
      ics("UID:utc@example.com", "DTSTART:20260115T090000Z", "DTEND:20260115T093000Z"),
    );

    expect(event?.dtStart.toISOString()).toBe("2026-01-15T09:00:00.000Z");
    expect(event?.dtEnd?.toISOString()).toBe("2026-01-15T09:30:00.000Z");
    expect(event?.timeZone).toBeNull();
  });

  it("stores all-day events as UTC midnight, whatever timezone the machine runs in", () => {
    const documents = ["UTC", "America/New_York", "Asia/Tokyo"].map((timeZone) => {
      process.env.TZ = timeZone;
      const [event] = parseICS(
        ics("UID:allday@example.com", "DTSTART;VALUE=DATE:20260115", "DTEND;VALUE=DATE:20260116"),
      );
      return {
        start: event?.dtStart.toISOString(),
        end: event?.dtEnd?.toISOString(),
        allDay: event?.allDay,
        timeZone: event?.timeZone,
      };
    });

    for (const parsed of documents) {
      expect(parsed).toEqual({
        start: "2026-01-15T00:00:00.000Z",
        end: "2026-01-16T00:00:00.000Z",
        allDay: true,
        timeZone: null,
      });
    }
  });

  it("keeps the wall clock but drops an unknown TZID", () => {
    process.env.TZ = "UTC";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const [event] = parseICS(
      ics("UID:windows-tz@example.com", "DTSTART;TZID=W. Europe Standard Time:20260115T090000"),
    );

    expect(event?.dtStart.toISOString()).toBe("2026-01-15T09:00:00.000Z");
    expect(event?.timeZone).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("W. Europe Standard Time"));
  });

  it("ignores a TZID on an all-day event", () => {
    process.env.TZ = "UTC";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const [event] = parseICS(
      ics("UID:allday-tz@example.com", "DTSTART;VALUE=DATE;TZID=Europe/Athens:20260115"),
    );

    expect(event?.dtStart.toISOString()).toBe("2026-01-15T00:00:00.000Z");
    expect(event?.allDay).toBe(true);
    expect(event?.timeZone).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("all-day event"));
  });

  it("falls back to a usable instant when an event has no start", () => {
    const [event] = parseICS(ics("UID:no-start@example.com", "SUMMARY:Broken"));

    expect(event?.dtStart).toBeInstanceOf(Date);
    expect(Number.isNaN(event?.dtStart.getTime())).toBe(false);
  });
});
