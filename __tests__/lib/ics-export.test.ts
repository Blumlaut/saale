import { describe, it, expect, vi } from "vitest";
import { generateICS, generateICSBulk, type ICSExportEvent } from "@/lib/calendar/ics-export";

const baseEvent: ICSExportEvent = {
  uid: "test-event-001@saale",
  summary: "Team Standup",
  description: "Daily sync meeting",
  location: "Room 101",
  dtStart: new Date("2025-01-15T09:00:00Z"),
  dtEnd: new Date("2025-01-15T09:30:00Z"),
  allDay: false,
  timeZone: "UTC",
  recurrenceRule: null,
  status: null,
  transparency: null,
};

describe("ics-export", () => {
  describe("generateICS", () => {
    it("produces valid ICS output with BEGIN:VCALENDAR", () => {
      const ics = generateICS(baseEvent);
      expect(ics).toContain("BEGIN:VCALENDAR");
      expect(ics).toContain("END:VCALENDAR");
    });

    it("includes the event UID", () => {
      const ics = generateICS(baseEvent);
      expect(ics).toContain("test-event-001@saale");
    });

    it("includes the event summary", () => {
      const ics = generateICS(baseEvent);
      expect(ics).toContain("Team Standup");
    });

    it("includes the event description", () => {
      const ics = generateICS(baseEvent);
      expect(ics).toContain("Daily sync meeting");
    });

    it("includes the event location", () => {
      const ics = generateICS(baseEvent);
      expect(ics).toContain("Room 101");
    });

    it("includes the event start and end dates", () => {
      const ics = generateICS(baseEvent);
      expect(ics).toContain("DTSTART");
      expect(ics).toContain("DTEND");
    });

    it("includes prodid", () => {
      const ics = generateICS(baseEvent);
      expect(ics).toContain("-//Saale//Calendar//EN");
    });

    it("handles null description and location", () => {
      const event = { ...baseEvent, description: null, location: null };
      const ics = generateICS(event);
      expect(ics).toContain("BEGIN:VCALENDAR");
      expect(ics).toContain("Team Standup");
    });

    it("handles all-day events", () => {
      const event = {
        ...baseEvent,
        allDay: true,
        dtEnd: new Date("2025-01-16T00:00:00Z"),
      };
      const ics = generateICS(event);
      expect(ics).toContain("BEGIN:VEVENT");
      expect(ics).toContain("END:VEVENT");
    });

    it("handles events without dtEnd (defaults to 1 hour)", () => {
      const event = { ...baseEvent, dtEnd: null };
      const ics = generateICS(event);
      expect(ics).toContain("DTEND");
    });

    it("includes recurrence rule when provided", () => {
      const event = { ...baseEvent, recurrenceRule: "FREQ=DAILY;INTERVAL=1" };
      const ics = generateICS(event);
      expect(ics).toContain("RRULE");
      expect(ics).toContain("FREQ=DAILY");
    });

    it("omits recurrence rule when null", () => {
      const ics = generateICS(baseEvent);
      expect(ics).not.toContain("RRULE");
    });

    it("includes status and transparency when provided", () => {
      const event = { ...baseEvent, status: "CONFIRMED", transparency: "OPAQUE" };
      const ics = generateICS(event);
      expect(ics).toContain("STATUS:CONFIRMED");
      expect(ics).toContain("TRANSP:OPAQUE");
    });

    it("includes timezone when provided", () => {
      const event = { ...baseEvent, timeZone: "America/New_York" };
      const ics = generateICS(event);
      expect(ics).toContain("America/New_York");
    });

    it("writes the zone's wall clock for a timezone-aware event", () => {
      const event = {
        ...baseEvent,
        dtStart: new Date("2026-01-15T07:00:00Z"),
        dtEnd: new Date("2026-01-15T08:00:00Z"),
        timeZone: "Europe/Athens",
      };

      const ics = generateICS(event);

      expect(ics).toContain("DTSTART;TZID=Europe/Athens:20260115T090000");
      expect(ics).toContain("DTEND;TZID=Europe/Athens:20260115T100000");
    });

    it("applies the offset in force on the event date", () => {
      const event = {
        ...baseEvent,
        dtStart: new Date("2026-07-15T07:00:00Z"),
        dtEnd: null,
        timeZone: "Europe/Athens",
      };

      expect(generateICS(event)).toContain("DTSTART;TZID=Europe/Athens:20260715T100000");
    });

    it("writes UTC times without a TZID for a UTC event", () => {
      const event = {
        ...baseEvent,
        dtStart: new Date("2026-01-15T09:00:00Z"),
        dtEnd: null,
        timeZone: "UTC",
      };
      const ics = generateICS(event);

      expect(ics).toContain("DTSTART:20260115T090000Z");
      expect(ics).not.toContain("TZID");
    });

    it("keeps the date of an all-day event in a negative-offset zone", () => {
      const event = {
        ...baseEvent,
        allDay: true,
        dtStart: new Date("2026-01-15T00:00:00Z"),
        dtEnd: new Date("2026-01-16T00:00:00Z"),
        timeZone: "America/New_York",
      };

      const ics = generateICS(event);

      expect(ics).toContain("DTSTART;VALUE=DATE:20260115");
      expect(ics).toContain("DTEND;VALUE=DATE:20260116");
      expect(ics).not.toContain("TZID");
    });

    it("falls back to a UTC instant when the stored zone is not a zone", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const event = {
        ...baseEvent,
        dtStart: new Date("2026-01-15T09:00:00Z"),
        dtEnd: null,
        timeZone: "W. Europe Standard Time",
      };

      const ics = generateICS(event);

      expect(ics).toContain("DTSTART:20260115T090000Z");
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("W. Europe Standard Time"));
      warn.mockRestore();
    });

    it("has the same DTSTART no matter which timezone the machine runs in", () => {
      const originalTimeZone = process.env.TZ;
      const event = {
        ...baseEvent,
        dtStart: new Date("2026-01-15T07:00:00Z"),
        dtEnd: null,
        timeZone: "Europe/Athens",
      };

      try {
        const results = ["UTC", "America/New_York", "Asia/Tokyo"].map((timeZone) => {
          process.env.TZ = timeZone;
          return /DTSTART;[^\r\n]*/.exec(generateICS(event))?.[0];
        });

        expect(results).toEqual([
          "DTSTART;TZID=Europe/Athens:20260115T090000",
          "DTSTART;TZID=Europe/Athens:20260115T090000",
          "DTSTART;TZID=Europe/Athens:20260115T090000",
        ]);
      } finally {
        process.env.TZ = originalTimeZone;
      }
    });
  });

  describe("generateICSBulk", () => {
    it("produces valid ICS with multiple events", () => {
      const events = [
        baseEvent,
        {
          ...baseEvent,
          uid: "test-event-002@saale",
          summary: "1:1 Meeting",
          dtStart: new Date("2025-01-15T14:00:00Z"),
          dtEnd: new Date("2025-01-15T14:30:00Z"),
        },
      ];
      const ics = generateICSBulk(events);
      expect(ics).toContain("BEGIN:VCALENDAR");
      expect(ics).toContain("Team Standup");
      expect(ics).toContain("1:1 Meeting");
    });

    it("includes all event UIDs", () => {
      const events = [
        baseEvent,
        {
          ...baseEvent,
          uid: "test-event-003@saale",
          summary: "Sprint Planning",
        },
      ];
      const ics = generateICSBulk(events);
      expect(ics).toContain("test-event-001@saale");
      expect(ics).toContain("test-event-003@saale");
    });

    it("handles empty event list", () => {
      const ics = generateICSBulk([]);
      expect(ics).toContain("BEGIN:VCALENDAR");
      expect(ics).toContain("END:VCALENDAR");
    });

    it("uses Saale Calendar Export name for bulk", () => {
      const ics = generateICSBulk([baseEvent]);
      expect(ics).toContain("Saale Calendar Export");
    });

    it("handles events with mixed recurrence rules", () => {
      const events = [
        baseEvent,
        {
          ...baseEvent,
          uid: "recurring@saale",
          summary: "Weekly Review",
          recurrenceRule: "FREQ=WEEKLY;BYDAY=FR",
        },
      ];
      const ics = generateICSBulk(events);
      // Only the second event has RRULE
      expect(ics).toContain("FREQ=WEEKLY");
    });
  });
});
