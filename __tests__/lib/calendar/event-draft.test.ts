import { describe, expect, it } from "vitest";

import {
  draftForDate,
  draftFromEvent,
  eventDraftPayload,
  EMPTY_EVENT_DRAFT,
} from "@/lib/calendar/event-draft";

const event = {
  id: "evt-1",
  uid: "uid-1",
  calendarId: "cal-1",
  calendarName: "Work",
  calendarColor: null,
  summary: "Standup",
  description: null,
  location: "Room 3",
  dtStart: "2026-03-02T09:00:00.000Z",
  dtEnd: null,
  allDay: false,
  source: "caldav",
};

describe("event drafts", () => {
  it("fills a draft from an event without an end or a description", () => {
    expect(draftFromEvent(event)).toEqual({
      summary: "Standup",
      description: "",
      location: "Room 3",
      dtStart: "2026-03-02T09:00",
      dtEnd: "",
      allDay: false,
    });
  });

  it("starts an hour before the end", () => {
    const date = new Date("2026-03-02T09:00:00.000Z");
    const { dtStart, dtEnd } = draftForDate(date);
    expect(new Date(dtEnd).getTime() - new Date(dtStart).getTime()).toBe(60 * 60 * 1000);
  });

  it("sends empty text as null and dates as ISO", () => {
    expect(
      eventDraftPayload({ ...EMPTY_EVENT_DRAFT, summary: "Review", dtStart: "2026-03-02T09:00" }),
    ).toEqual({
      summary: "Review",
      description: null,
      location: null,
      dtStart: new Date("2026-03-02T09:00").toISOString(),
      dtEnd: null,
      allDay: false,
    });
  });
});
