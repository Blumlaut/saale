import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─── Mocks ───────────────────────────────────────────────────────────────────

const { mockCalendarEvent } = vi.hoisted(() => ({
  mockCalendarEvent: { findMany: vi.fn(), updateMany: vi.fn() },
}));

vi.mock("@/lib/db", () => ({ prisma: { calendarEvent: mockCalendarEvent } }));

const mockNotifyUser = vi.fn();
vi.mock("@/lib/notifications/notify", () => ({
  notifyUser: (...args: unknown[]) => mockNotifyUser(...args),
}));

const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

import {
  DEFAULT_REMINDER_MINUTES,
  reminderLeadMinutes,
  sendCalendarReminders,
} from "@/lib/notifications/calendar-reminders";

const NOW = new Date("2026-03-10T09:00:00.000Z");
const minutes = (count: number) => new Date(NOW.getTime() + count * 60_000);

/** An event row in the shape the sweep selects. */
function event(overrides: Record<string, unknown> = {}) {
  return {
    id: "event-1",
    summary: "Stand-up",
    dtStart: minutes(10),
    location: null,
    alerts: null,
    calendar: { account: { userId: "user-1" } },
    ...overrides,
  };
}

describe("calendar reminders", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCalendarEvent.updateMany.mockResolvedValue({ count: 1 });
    mockNotifyUser.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reminds for an event that has reached its lead time", async () => {
    mockCalendarEvent.findMany.mockResolvedValue([event({ location: "Room 4" })]);

    const result = await sendCalendarReminders(NOW);

    expect(result).toEqual({ scanned: 1, due: 1, notified: 1 });
    expect(mockNotifyUser).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        category: "calendar",
        title: "Stand-up",
        body: "Starting in 10 minutes · Room 4",
        url: "/dashboard/calendar",
        tag: "event-event-1",
        inApp: true,
      }),
    );
    // Marked so the next minute's sweep leaves it alone.
    expect(mockCalendarEvent.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["event-1"] }, remindedAt: null },
      data: { remindedAt: NOW },
    });
  });

  it("leaves an event alone until its reminder is due", async () => {
    mockCalendarEvent.findMany.mockResolvedValue([event({ dtStart: minutes(40) })]);

    const result = await sendCalendarReminders(NOW);

    expect(result).toEqual({ scanned: 1, due: 0, notified: 0 });
    expect(mockNotifyUser).not.toHaveBeenCalled();
    expect(mockCalendarEvent.updateMany).not.toHaveBeenCalled();
  });

  it("honours an event's own alert instead of the default lead", async () => {
    mockCalendarEvent.findMany.mockResolvedValue([
      event({ dtStart: minutes(45), alerts: JSON.stringify([{ triggerMinutes: 60 }]) }),
    ]);

    const result = await sendCalendarReminders(NOW);

    expect(result.due).toBe(1);
  });

  it("says an event is starting now when the lead time already passed", async () => {
    mockCalendarEvent.findMany.mockResolvedValue([event({ dtStart: minutes(1) })]);

    await sendCalendarReminders(NOW);

    expect(mockNotifyUser.mock.calls[0]?.[0]).toMatchObject({ body: "Starting in 1 minute" });
  });

  it("marks a reminder that could not be delivered as spent, and keeps going", async () => {
    mockCalendarEvent.findMany.mockResolvedValue([
      event({ id: "event-1" }),
      event({ id: "event-2", summary: "Review" }),
    ]);
    mockNotifyUser.mockRejectedValueOnce(new Error("push service down"));

    const result = await sendCalendarReminders(NOW);

    expect(result).toEqual({ scanned: 2, due: 2, notified: 1 });
    expect(consoleErrorSpy).toHaveBeenCalled();
    expect(mockCalendarEvent.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["event-1", "event-2"] }, remindedAt: null },
      data: { remindedAt: NOW },
    });
  });

  it("skips all-day events and cancelled ones before they reach the notifier", async () => {
    mockCalendarEvent.findMany.mockResolvedValue([]);

    await sendCalendarReminders(NOW);

    const where = mockCalendarEvent.findMany.mock.calls[0]?.[0].where;
    expect(where).toMatchObject({
      remindedAt: null,
      allDay: false,
      calendar: { enabled: true, account: { enabled: true } },
    });
    expect(mockNotifyUser).not.toHaveBeenCalled();
  });

  it("reads the earliest alert, and falls back when it cannot", () => {
    expect(reminderLeadMinutes(null)).toBe(DEFAULT_REMINDER_MINUTES);
    expect(
      reminderLeadMinutes(JSON.stringify([{ triggerMinutes: 30 }, { triggerMinutes: 5 }])),
    ).toBe(5);
    expect(reminderLeadMinutes("{not json")).toBe(DEFAULT_REMINDER_MINUTES);
    expect(reminderLeadMinutes(JSON.stringify([{ triggerMinutes: -30 }]))).toBe(
      DEFAULT_REMINDER_MINUTES,
    );
    expect(consoleErrorSpy).toHaveBeenCalled();
  });
});
