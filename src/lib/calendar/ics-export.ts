import ical from "ical-generator";

export interface ICSExportEvent {
  uid: string;
  summary: string;
  description?: string;
  location?: string;
  dtStart: Date;
  dtEnd?: Date;
  allDay?: boolean;
  timeZone?: string;
  recurrenceRule?: string;
  status?: string;
  transparency?: string;
}

/**
 * Generate a single .ics string for one event.
 * Used for CalDAV push operations.
 */
export function generateICS(event: ICSExportEvent): string {
  const cal = createCalendar(event);
  return cal.toString();
}

/**
 * Generate a .ics string for multiple events.
 * Used for bulk export/download.
 */
export function generateICSBulk(events: ICSExportEvent[]): string {
  const cal = ical();
  cal.prodId("-//Saale//Calendar//EN");
  cal.name("Saale Calendar Export");

  for (const evt of events) {
    const icalEvent = cal.createEvent({
      id: evt.uid,
      start: evt.dtStart,
      end: evt.dtEnd ?? new Date(evt.dtStart.getTime() + 60 * 60 * 1000),
      summary: evt.summary,
      description: evt.description ?? null,
      location: evt.location ?? null,
      timezone: evt.timeZone ?? null,
      allDay: evt.allDay ?? false,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ical-generator enums are opaque
      status: evt.status as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ical-generator enums are opaque
      transparency: evt.transparency as any,
    });

    if (evt.recurrenceRule) {
      icalEvent.repeating(evt.recurrenceRule);
    }
  }

  return cal.toString();
}

/**
 * Create a Calendar instance with a single event.
 */
function createCalendar(event: ICSExportEvent): ReturnType<typeof ical> {
  const cal = ical();
  cal.prodId("-//Saale//Calendar//EN");
  cal.name("Saale");

  const icalEvent = cal.createEvent({
    id: event.uid,
    start: event.dtStart,
    end: event.dtEnd ?? new Date(event.dtStart.getTime() + 60 * 60 * 1000),
    summary: event.summary,
    description: event.description ?? null,
    location: event.location ?? null,
    timezone: event.timeZone ?? null,
    allDay: event.allDay ?? false,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ical-generator enums are opaque
    status: event.status as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ical-generator enums are opaque
    transparency: event.transparency as any,
  });

  if (event.recurrenceRule) {
    icalEvent.repeating(event.recurrenceRule);
  }

  return cal;
}
