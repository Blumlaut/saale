// @ts-expect-error -- ical has no TypeScript declarations
import ical from "ical";

export interface ParsedEvent {
  uid: string;
  summary: string;
  description: string | null;
  location: string | null;
  url: string | null;
  status: string | null;
  transparency: string | null;
  sequence: number;
  dtStart: Date;
  dtEnd: Date | null;
  allDay: boolean;
  timeZone: string | null;
  recurrenceRule: string | null;
  alerts: { triggerMinutes: number; action: string }[];
}

/**
 * Extract a string value from an ical field that may be a plain string,
 * an object with { val, params } (e.g. URL;VALUE=URI), or something else.
 */
function extractString(val: unknown): string | null {
  if (typeof val === "string") return val || null;
  if (val && typeof val === "object" && "val" in val) {
    return (val as { val: string }).val || null;
  }
  return null;
}

/**
 * Parse a raw iCalendar (.ics) string and extract events.
 * Returns an array of parsed events.
 */
export function parseICS(icsContent: string): ParsedEvent[] {
  const data = ical.parseICS(icsContent);
  const events: ParsedEvent[] = [];

  for (const [, val] of Object.entries(data)) {
    const obj = val as Record<string, unknown>;
    if (!obj || typeof obj !== "object") continue;

    // Some ICS files have VEVENTs directly at the top level
    if (obj.type === "VEVENT") {
      events.push(extractEvent(obj));
      continue;
    }

    // Standard: VCALENDAR wrapping VEVENTs
    if (obj.type === "VCALENDAR") {
      for (const [, vevent] of Object.entries(obj)) {
        const event = vevent as Record<string, unknown>;
        if (event?.type === "VEVENT") {
          events.push(extractEvent(event));
        }
      }
    }
  }

  return events;
}

/**
 * Extract a single VEVENT object into a ParsedEvent.
 */
function extractEvent(vevent: Record<string, unknown>): ParsedEvent {
  const dtStart = vevent.start as Date | { year: number; month: number; day: number } | undefined;
  const dtEnd = vevent.end as Date | { year: number; month: number; day: number } | undefined;

  // Determine if all-day from multiple signals:
  // 1. ical returns { year, month, day } objects (no getTime)
  // 2. The raw dtstart has VALUE=DATE param
  const isDateObject = dtStart && typeof dtStart === "object" && !("getTime" in dtStart);
  const rawDtStart = vevent.dtstart as
    | { params?: Record<string, unknown>; val?: unknown }
    | undefined;
  const hasValueDate =
    typeof rawDtStart?.params === "object" &&
    (rawDtStart.params.VALUE === "DATE" || rawDtStart.params.value === "DATE");
  const allDay = !!isDateObject || !!hasValueDate;

  const startDate =
    isDateObject && dtStart && "year" in dtStart
      ? new Date(dtStart.year, dtStart.month - 1, dtStart.day)
      : dtStart instanceof Date
        ? new Date(dtStart)
        : new Date();

  const endDate = dtEnd
    ? isDateObject && "year" in dtEnd
      ? new Date(dtEnd.year, dtEnd.month - 1, dtEnd.day)
      : dtEnd instanceof Date
        ? new Date(dtEnd)
        : null
    : null;

  return {
    uid: (vevent.uid as string) || generateUID(),
    summary: (vevent.summary as string) || "(no title)",
    description: (vevent.description as string) || null,
    location: (vevent.location as string) || null,
    url: extractString(vevent.url) || null,
    status: (vevent.status as string) || null,
    transparency: (vevent.transparency as string) || null,
    sequence: (vevent.sequence as number) ?? 0,
    dtStart: startDate,
    dtEnd: endDate,
    allDay: !!allDay,
    timeZone: (vevent["tzid"] as string) || null,
    recurrenceRule: vevent.rrule ? (vevent.rrule as { toString: () => string }).toString() : null,
    alerts: parseAlerts(vevent),
  };
}

/**
 * Parse VALARM components into alert objects.
 */
function parseAlerts(
  vevent: Record<string, unknown>,
): { triggerMinutes: number; action: string }[] {
  const alarms = vevent.alarms as Record<string, unknown> | undefined;
  if (!alarms) return [];

  const alerts: { triggerMinutes: number; action: string }[] = [];
  for (const [, alarm] of Object.entries(alarms)) {
    const a = alarm as Record<string, unknown>;
    if (a?.type !== "VALARM") continue;

    const trigger = a.trigger as
      | { value: { days?: number; hours?: number; minutes?: number; seconds?: number } }
      | undefined;
    let triggerMinutes = 0;

    if (trigger && "value" in trigger && typeof trigger.value === "object") {
      const duration = trigger.value;
      triggerMinutes =
        (duration.days ?? 0) * 1440 + (duration.hours ?? 0) * 60 + (duration.minutes ?? 0);
    }

    alerts.push({
      triggerMinutes,
      action: (a.action as string) || "DISPLAY",
    });
  }

  return alerts;
}

/**
 * Generate a simple UID for events without one.
 */
function generateUID(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return `${timestamp}-${random}@saale-local`;
}
