// @ts-expect-error -- ical has no TypeScript declarations
import ical from "ical";
import { formatLocalWallClock, isValidTimeZone, resolveEventDateTime } from "./timezone";

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
 * Read the TZID of a parsed datetime field. The `ical` parser keeps it on the
 * Date it returns (`start.tz`), not in a `tzid` property.
 */
function extractTimeZone(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const tz = (value as { tz?: unknown }).tz;
  if (typeof tz === "string" && tz) return tz;
  const params = (value as { params?: unknown }).params;
  const paramTz =
    params && typeof params === "object"
      ? extractString((params as Record<string, unknown>).TZID)
      : null;
  return paramTz;
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

  // Detect all-day from multiple signals:
  // 1. ical returns { year, month, day } objects (no getTime)
  // 2. The raw dtstart has VALUE=DATE param
  // 3. ical flags date-only values on the Date it returns
  const isDateObject = dtStart && typeof dtStart === "object" && !("getTime" in dtStart);
  const rawDtStart = vevent.dtstart as
    { params?: Record<string, unknown>; val?: unknown } | undefined;
  const hasValueDate =
    typeof rawDtStart?.params === "object" &&
    (rawDtStart.params.VALUE === "DATE" || rawDtStart.params.value === "DATE");
  const isDateOnly = (dtStart as { dateOnly?: boolean } | undefined)?.dateOnly === true;
  const allDay = !!isDateObject || !!hasValueDate || isDateOnly;

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

  const rawTimeZone = extractTimeZone(vevent.start) ?? extractTimeZone(vevent.end);
  const timeZone = rawTimeZone && isValidTimeZone(rawTimeZone) ? rawTimeZone : null;
  if (rawTimeZone && !timeZone) {
    console.warn(
      `Unknown TZID "${rawTimeZone}" on imported event ${String(vevent.uid)}; keeping the parsed wall clock as UTC`,
    );
  }
  if (allDay && timeZone) {
    console.warn(
      `Ignoring TZID "${timeZone}" on all-day event ${String(vevent.uid)}; all-day dates are stored as UTC dates`,
    );
  }

  // All-day events are stored as UTC midnight of their calendar date; timed
  // events are stored as the instant their timezone gives them. The parser read
  // both on the machine's clock, so re-anchor from its local wall clock.
  const normalizeDate = (date: Date | null): Date | null => {
    if (!date) return null;
    const wallClock = formatLocalWallClock(date);
    if (allDay) return resolveEventDateTime(wallClock, { allDay: true });
    return timeZone ? resolveEventDateTime(wallClock, { timeZone }) : date;
  };

  return {
    uid: (vevent.uid as string) || generateUID(),
    summary: (vevent.summary as string) || "(no title)",
    description: (vevent.description as string) || null,
    location: (vevent.location as string) || null,
    url: extractString(vevent.url) || null,
    status: (vevent.status as string) || null,
    transparency: (vevent.transparency as string) || null,
    sequence:
      typeof vevent.sequence === "number"
        ? vevent.sequence
        : parseInt(String(vevent.sequence), 10) || 0,
    dtStart: normalizeDate(startDate) ?? startDate,
    dtEnd: normalizeDate(endDate),
    allDay: !!allDay,
    timeZone: allDay ? null : timeZone,
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
      { value: { days?: number; hours?: number; minutes?: number; seconds?: number } } | undefined;
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
