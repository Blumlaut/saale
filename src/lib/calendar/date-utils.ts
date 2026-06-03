import type { CalendarEvent } from "@/types/shared";

/**
 * Strip time from a date, returning UTC midnight.
 * All calendar dates are handled in UTC to avoid timezone drift
 * between the browser (local time) and the DB (UTC timestamps).
 */
export function startOfDayUTC(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/**
 * Check if a calendar event overlaps a given day (UTC midnight to midnight).
 */
export function eventOverlapsDay(event: CalendarEvent, day: Date): boolean {
  const dayStart = startOfDayUTC(day).getTime();
  const dayEnd = dayStart + 86400000; // +1 day
  const evtStart = new Date(event.dtStart).getTime();
  const evtEnd = event.dtEnd ? new Date(event.dtEnd).getTime() : evtStart;
  return evtStart < dayEnd && evtEnd > dayStart;
}

/**
 * Get all events (all-day) for a specific day.
 */
export function getAllDayEventsForDay(events: CalendarEvent[], day: Date): CalendarEvent[] {
  return events.filter((e) => e.allDay && eventOverlapsDay(e, day));
}

/**
 * Get all timed (non-all-day) events for a specific day.
 */
export function getTimedEventsForDay(events: CalendarEvent[], day: Date): CalendarEvent[] {
  return events.filter((e) => !e.allDay && eventOverlapsDay(e, day));
}

/**
 * Get all events (both all-day and timed) for a specific day.
 */
export function getEventsForDay(events: CalendarEvent[], day: Date): CalendarEvent[] {
  return events.filter((e) => eventOverlapsDay(e, day));
}

/**
 * Check if two dates are the same calendar day (UTC).
 */
export function isSameDayUTC(a: Date, b: Date): boolean {
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate()
  );
}

/**
 * Get the start of the week (Monday) for a given date, in UTC.
 */
export function startOfWeekUTC(d: Date): Date {
  const date = new Date(d);
  const day = date.getUTCDay();
  const diff = date.getUTCDate() - day + (day === 0 ? -6 : 1);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), diff));
}

/**
 * Get the 7 days of the week starting from Monday (UTC).
 */
export function getWeekDaysUTC(d: Date): Date[] {
  const weekStart = startOfWeekUTC(d);
  return Array.from({ length: 7 }, (_, i) => {
    const day = new Date(weekStart);
    day.setUTCDate(day.getUTCDate() + i);
    return day;
  });
}
