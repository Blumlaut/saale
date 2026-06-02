import type { CalendarEvent } from "@/types/shared";

/**
 * Strip time from a date, returning midnight local time.
 */
export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/**
 * Check if a calendar event overlaps a given day (midnight to midnight).
 */
export function eventOverlapsDay(event: CalendarEvent, day: Date): boolean {
  const dayStart = startOfDay(day).getTime();
  const dayEnd = dayStart + 86400000; // +1 day
  const evtStart = new Date(event.dtStart).getTime();
  const evtEnd = event.dtEnd ? new Date(event.dtEnd).getTime() : evtStart;
  const overlaps = evtStart < dayEnd && evtEnd > dayStart;
  if (!overlaps && process.env.NODE_ENV === "development") {
    console.warn(
      "eventOverlapsDay miss",
      event.summary,
      "evtStart:",
      new Date(evtStart).toISOString(),
      "day:",
      new Date(dayStart).toISOString(),
      "dayEnd:",
      new Date(dayEnd).toISOString(),
    );
  }
  return overlaps;
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
 * Check if two dates are the same calendar day.
 */
export function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * Get the start of the week (Monday) for a given date.
 */
export function startOfWeek(d: Date): Date {
  const date = new Date(d);
  const day = date.getDay();
  const diff = date.getDate() - day + (day === 0 ? -6 : 1);
  date.setDate(diff);
  return startOfDay(date);
}

/**
 * Get the 7 days of the week starting from Monday.
 */
export function getWeekDays(d: Date): Date[] {
  const weekStart = startOfWeek(d);
  return Array.from({ length: 7 }, (_, i) => {
    const day = new Date(weekStart);
    day.setDate(day.getDate() + i);
    return day;
  });
}
