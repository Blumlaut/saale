import ical from "ical-generator";

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
      description: evt.description,
      location: evt.location,
      timezone: evt.timeZone,
      allDay: evt.allDay,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ical-generator enums are opaque
      status: evt.status as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ical-generator enums are opaque
      transparency: evt.transparency as any,
    });

    if (evt.recurrenceRule && evt.recurrenceRule) {
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
    description: event.description,
    location: event.location,
    timezone: event.timeZone,
    allDay: event.allDay,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ical-generator enums are opaque
    status: event.status as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ical-generator enums are opaque
    transparency: event.transparency as any,
  });

  if (event.recurrenceRule && event.recurrenceRule) {
    icalEvent.repeating(event.recurrenceRule);
  }

  return cal;
}
