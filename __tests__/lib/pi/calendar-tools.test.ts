import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    calendar: {
      findFirst: vi.fn(),
    },
    calendarEvent: {
      create: vi.fn(),
      update: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      delete: vi.fn(),
    },
  },
}));

vi.mock("@/lib/calendar/caldav", () => ({
  pushEventToCalDAV: vi
    .fn()
    .mockResolvedValue({ success: true, remoteUrl: null, etag: null, error: null }),
}));

import * as db from "@/lib/db";
import * as caldav from "@/lib/calendar/caldav";
import { createCalendarTools } from "@/lib/pi/tools/calendar-tools";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockCalendar = db.prisma.calendar as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockEvent = db.prisma.calendarEvent as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockPushEvent = caldav.pushEventToCalDAV as any;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getTool = (name: string): any => {
  const tool = createCalendarTools("user-1").find((t) => t.name === name);
  if (!tool) throw new Error(`Tool ${name} not found`);
  return tool;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const callExecute = (tool: any, params: Record<string, unknown>) =>
  tool.execute("call-1", params, undefined, undefined, {} as never);

/** Echo the data written back, the way Prisma returns the created row. */
const echoStoredEvent = () =>
  mockEvent.create.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
    Promise.resolve({ id: "evt-1", ...data }),
  );

/** Echo merged rows for updates. */
const echoUpdatedEvent = (current: Record<string, unknown>) =>
  mockEvent.update.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
    Promise.resolve({ id: "evt-1", ...current, ...data }),
  );

const athensEvent = {
  id: "evt-1",
  uid: "evt-1@saale",
  summary: "Standup",
  dtStart: new Date("2026-01-15T07:00:00Z"), // 09:00 in Athens
  dtEnd: new Date("2026-01-15T08:00:00Z"),
  timeZone: "Europe/Athens",
  allDay: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockCalendar.findFirst.mockResolvedValue({ id: "cal-1", remoteId: null, account: {} });
  echoStoredEvent();
  echoUpdatedEvent(athensEvent);
});

describe("calendar_create timezone handling", () => {
  it("anchors a wall-clock start and end in the given timezone", async () => {
    const result = await callExecute(getTool("calendar_create"), {
      calendarId: "cal-1",
      summary: "Standup",
      dtStart: "2026-01-15T09:00:00",
      dtEnd: "2026-01-15T10:00:00",
      timeZone: "Europe/Athens",
    });

    const stored = mockEvent.create.mock.calls[0][0].data;
    expect(stored.dtStart.toISOString()).toBe("2026-01-15T07:00:00.000Z");
    expect(stored.dtEnd.toISOString()).toBe("2026-01-15T08:00:00.000Z");
    expect(stored.timeZone).toBe("Europe/Athens");

    const payload = JSON.parse(result.content[0].text);
    expect(payload.event.dtStart).toBe("2026-01-15T07:00:00.000Z");
    expect(payload.event.timeZone).toBe("Europe/Athens");
    expect(payload.event.localStart).toBe("2026-01-15T09:00:00");
  });

  it("keeps an absolute start absolute and uses it as the label only", async () => {
    await callExecute(getTool("calendar_create"), {
      calendarId: "cal-1",
      summary: "Standup",
      dtStart: "2026-01-15T09:00:00Z",
      timeZone: "Europe/Athens",
    });

    const stored = mockEvent.create.mock.calls[0][0].data;
    expect(stored.dtStart.toISOString()).toBe("2026-01-15T09:00:00.000Z");
    expect(stored.timeZone).toBe("Europe/Athens");
  });

  it("defaults to a one hour event ending after the resolved start", async () => {
    await callExecute(getTool("calendar_create"), {
      calendarId: "cal-1",
      summary: "Standup",
      dtStart: "2026-01-15T23:30:00",
      timeZone: "Europe/Athens",
    });

    const stored = mockEvent.create.mock.calls[0][0].data;
    expect(stored.dtStart.toISOString()).toBe("2026-01-15T21:30:00.000Z");
    expect(stored.dtEnd.toISOString()).toBe("2026-01-15T22:30:00.000Z");
  });

  it("stores a wall clock without a timezone as UTC", async () => {
    await callExecute(getTool("calendar_create"), {
      calendarId: "cal-1",
      summary: "Standup",
      dtStart: "2026-01-15T09:00:00",
    });

    const stored = mockEvent.create.mock.calls[0][0].data;
    expect(stored.dtStart.toISOString()).toBe("2026-01-15T09:00:00.000Z");
    expect(stored.timeZone).toBeNull();
  });

  it("stores all-day events as UTC dates", async () => {
    await callExecute(getTool("calendar_create"), {
      calendarId: "cal-1",
      summary: "Holiday",
      dtStart: "2026-01-15",
      dtEnd: "2026-01-16",
      allDay: true,
      timeZone: "America/New_York",
    });

    const stored = mockEvent.create.mock.calls[0][0].data;
    expect(stored.dtStart.toISOString()).toBe("2026-01-15T00:00:00.000Z");
    expect(stored.dtEnd.toISOString()).toBe("2026-01-16T00:00:00.000Z");
  });

  it("rejects an unknown timezone instead of silently storing UTC", async () => {
    await expect(
      callExecute(getTool("calendar_create"), {
        calendarId: "cal-1",
        summary: "Standup",
        dtStart: "2026-01-15T09:00:00",
        timeZone: "Europe/Athenz",
      }),
    ).rejects.toThrow(/Unknown timezone "Europe\/Athenz"/);

    expect(mockEvent.create).not.toHaveBeenCalled();
  });

  it("pushes the anchored instant to CalDAV", async () => {
    mockCalendar.findFirst.mockResolvedValue({
      id: "cal-1",
      remoteId: "https://dav.example.com/cal-1",
      account: {},
    });

    const result = await callExecute(getTool("calendar_create"), {
      calendarId: "cal-1",
      summary: "Standup",
      dtStart: "2026-01-15T09:00:00",
      timeZone: "Europe/Athens",
    });

    const pushed = mockPushEvent.mock.calls[0][1];
    expect(pushed.dtStart.toISOString()).toBe("2026-01-15T07:00:00.000Z");
    expect(pushed.timeZone).toBe("Europe/Athens");
    expect(JSON.parse(result.content[0].text).caldavPush).toBe("pushed");
  });
});

describe("calendar_update timezone handling", () => {
  beforeEach(() => {
    mockEvent.findFirst.mockResolvedValue(athensEvent);
  });

  it("anchors a new wall-clock start in the event's own timezone", async () => {
    await callExecute(getTool("calendar_update"), {
      id: "evt-1",
      dtStart: "2026-01-15T12:00:00",
    });

    const stored = mockEvent.update.mock.calls[0][0].data;
    expect(stored.dtStart.toISOString()).toBe("2026-01-15T10:00:00.000Z");
    expect(stored.timeZone).toBeUndefined();
  });

  it("keeps the local time and duration when only the timezone changes", async () => {
    const result = await callExecute(getTool("calendar_update"), {
      id: "evt-1",
      timeZone: "Asia/Tokyo",
    });

    const stored = mockEvent.update.mock.calls[0][0].data;
    expect(stored.timeZone).toBe("Asia/Tokyo");
    expect(stored.dtStart.toISOString()).toBe("2026-01-15T00:00:00.000Z"); // 09:00 Tokyo
    expect(stored.dtEnd.toISOString()).toBe("2026-01-15T01:00:00.000Z");

    const payload = JSON.parse(result.content[0].text);
    expect(payload.event.localStart).toBe("2026-01-15T09:00:00");
  });

  it("anchors new times in the newly supplied timezone", async () => {
    await callExecute(getTool("calendar_update"), {
      id: "evt-1",
      dtStart: "2026-01-15T12:00:00",
      timeZone: "Asia/Tokyo",
    });

    const stored = mockEvent.update.mock.calls[0][0].data;
    expect(stored.timeZone).toBe("Asia/Tokyo");
    expect(stored.dtStart.toISOString()).toBe("2026-01-15T03:00:00.000Z");
  });

  it("clears the timezone without moving the event", async () => {
    await callExecute(getTool("calendar_update"), { id: "evt-1", timeZone: "" });

    const stored = mockEvent.update.mock.calls[0][0].data;
    expect(stored.timeZone).toBeNull();
    expect(stored.dtStart).toBeUndefined();
  });

  it("leaves times and timezone alone when they are not supplied", async () => {
    await callExecute(getTool("calendar_update"), { id: "evt-1", summary: "Renamed" });

    const stored = mockEvent.update.mock.calls[0][0].data;
    expect(stored).toEqual({ summary: "Renamed" });
  });

  it("rejects an unknown timezone", async () => {
    await expect(
      callExecute(getTool("calendar_update"), { id: "evt-1", timeZone: "CEST" }),
    ).rejects.toThrow(/Unknown timezone/);

    expect(mockEvent.update).not.toHaveBeenCalled();
  });

  it("scopes the lookup to the authenticated user", async () => {
    await callExecute(getTool("calendar_update"), { id: "evt-1", summary: "Renamed" });

    expect(mockEvent.findFirst).toHaveBeenCalledWith({
      where: { id: "evt-1", calendar: { account: { userId: "user-1" } } },
    });
  });
});
