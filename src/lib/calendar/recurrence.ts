/**
 * RRULE helpers for calendar events.
 * We store the raw RRULE string and provide helpers for common patterns.
 */

export interface RecurrencePattern {
  frequency: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
  interval?: number;
  count?: number;
  until?: Date;
  byDay?: string[]; // e.g. ["MO", "WE", "FR"]
  byMonthDay?: number[];
  byMonth?: number[];
}

/**
 * Convert a RecurrencePattern to an RRULE string.
 */
export function patternToRRule(pattern: RecurrencePattern): string {
  const parts = [
    `FREQ=${pattern.frequency}`,
    pattern.interval ? `INTERVAL=${pattern.interval}` : null,
    pattern.count ? `COUNT=${pattern.count}` : null,
    pattern.until ? `UNTIL=${formatRRuleDate(pattern.until)}` : null,
    pattern.byDay?.length ? `BYDAY=${pattern.byDay.join(",")}` : null,
    pattern.byMonthDay?.length ? `BYMONTHDAY=${pattern.byMonthDay.join(",")}` : null,
    pattern.byMonth?.length ? `BYMONTH=${pattern.byMonth.join(",")}` : null,
  ].filter(Boolean);

  return parts.join(";");
}

/**
 * Format a Date for use in an RRULE UNTIL value.
 * RRULE dates are in UTC format: YYYYMMDDTHHMMSSZ
 */
function formatRRuleDate(date: Date): string {
  return (
    date.getUTCFullYear().toString().padStart(4, "0") +
    (date.getUTCMonth() + 1).toString().padStart(2, "0") +
    date.getUTCDate().toString().padStart(2, "0") +
    "T" +
    date.getUTCHours().toString().padStart(2, "0") +
    date.getUTCMinutes().toString().padStart(2, "0") +
    date.getUTCSeconds().toString().padStart(2, "0") +
    "Z"
  );
}

/**
 * Common recurrence presets.
 */
export const RECURRENCE_PRESETS: { label: string; pattern: RecurrencePattern }[] = [
  { label: "Daily", pattern: { frequency: "DAILY" } },
  { label: "Weekly", pattern: { frequency: "WEEKLY" } },
  { label: "Every 2 weeks", pattern: { frequency: "WEEKLY", interval: 2 } },
  { label: "Monthly", pattern: { frequency: "MONTHLY" } },
  { label: "Yearly", pattern: { frequency: "YEARLY" } },
  { label: "Weekdays", pattern: { frequency: "WEEKLY", byDay: ["MO", "TU", "WE", "TH", "FR"] } },
  { label: "Weekends", pattern: { frequency: "WEEKLY", byDay: ["SA", "SU"] } },
];

/**
 * Check if a date falls within a recurrence range.
 * This is a simplified check. for full expansion use a dedicated RRULE library.
 */
export function isWithinRecurrenceRange(
  date: Date,
  dtStart: Date,
  recurrenceRule?: string,
): boolean {
  if (!recurrenceRule) return false;

  // For now, just check if date is after the start
  // Full RRULE expansion is deferred to the UI layer
  return date >= dtStart;
}
