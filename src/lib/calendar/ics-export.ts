import ical from "ical-generator";
import { isValidTimeZone, toZonedDate } from "./timezone";

export interface ICSExportEvent {
  uid: string;
  summary: string;
  description: string | null;
  location: string | null;
  dtStart: Date;
  dtEnd: Date | null;
  allDay: boolean;
  timeZone: string | null;
  recurrenceRule: string | null;
  status: string | null;
  transparency: string | null;
}

/**
 * Default duration for events without an end time (1 hour).
 */
export const DEFAULT_EVENT_DURATION_MS = 60 * 60 * 1000;

/**
 * ical-generator serializes a TZDate on that zone's clock, so timezone-aware
 * events keep their wall time regardless of the machine's own timezone. Plain
 * dates are written as UTC instants.
 */
function toICalDate(date: Date, timeZone: string | null): Date {
  return timeZone ? toZonedDate(date, timeZone) : date;
}

/**
 * Create a calendar instance with standard prodId.
 */
function createBaseCalendar(name = "Saale"): ReturnType<typeof ical> {
  const cal = ical();
  cal.prodId("-//Saale//Calendar//EN");
  cal.name(name);
  return cal;
}

/**
 * Add an ICSExportEvent to an existing calendar instance.
 * Returns the created ical-generator event for further customization.
 */
export function addEventToCalendar(
  cal: ReturnType<typeof ical>,
  event: ICSExportEvent,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ical-generator return type is opaque
): any {
  // All-day events are date-only (VALUE=DATE) and carry no TZID; an unknown
  // zone would otherwise be written verbatim next to a wall clock nobody can
  // resolve, so fall back to an absolute UTC time instead.
  const timeZone =
    !event.allDay && event.timeZone && isValidTimeZone(event.timeZone) ? event.timeZone : null;
  if (!event.allDay && event.timeZone && !timeZone) {
    console.warn(`Unknown timezone "${event.timeZone}" on event ${event.uid}; exporting it in UTC`);
  }

  const icalEvent = cal.createEvent({
    id: event.uid,
    start: toICalDate(event.dtStart, timeZone),
    end: toICalDate(
      event.dtEnd ?? new Date(event.dtStart.getTime() + DEFAULT_EVENT_DURATION_MS),
      timeZone,
    ),
    summary: event.summary,
    description: event.description,
    location: event.location,
    timezone: timeZone,
    allDay: event.allDay,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ical-generator enums are opaque
    status: event.status as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ical-generator enums are opaque
    transparency: event.transparency as any,
  });

  if (event.recurrenceRule) {
    icalEvent.repeating(event.recurrenceRule);
  }

  return icalEvent;
}

/**
 * Generate a single .ics string for one event.
 * Used for CalDAV push operations.
 */
export function generateICS(event: ICSExportEvent): string {
  const cal = createBaseCalendar();
  addEventToCalendar(cal, event);
  return cal.toString();
}

/**
 * Generate a .ics string for multiple events.
 * Used for bulk export/download.
 */
export function generateICSBulk(events: ICSExportEvent[]): string {
  const cal = createBaseCalendar("Saale Calendar Export");

  for (const evt of events) {
    addEventToCalendar(cal, evt);
  }

  return cal.toString();
}
