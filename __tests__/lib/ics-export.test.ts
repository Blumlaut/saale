import { describe, it, expect } from "vitest";
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
