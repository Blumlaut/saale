import { TZDate } from "@date-fns/tz";

/**
 * Timezone anchoring for calendar events.
 *
 * Events are stored as true UTC instants (`dtStart`/`dtEnd`) plus the IANA
 * `timeZone` the times were authored in. A wall-clock value without an offset
 * ("2026-01-15T09:00:00") carries no instant on its own: it has to be anchored
 * to a zone before it can be stored, otherwise the same input means a different
 * moment depending on which machine happened to parse it.
 */

/** ISO 8601 designator that makes a datetime absolute: `Z` or `±HH:MM`. */
const EXPLICIT_OFFSET = /(?:[zZ]|[+-]\d{2}:?\d{2})$/;

/** Naive ISO 8601 wall clock. date, optionally followed by a time. */
const WALL_CLOCK = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?$/;

const DATE_PART = /^(\d{4})-(\d{2})-(\d{2})/;

/** Shown in error messages so a model can correct itself with a usable zone. */
const EXAMPLE_TIME_ZONE = "Europe/Athens";

/** A bare UTC offset is not a zone name, and ICS rejects it as a TZID. */
const UTC_OFFSET_ONLY = /^[+-]\d{2}:?\d{2}$/;

export interface ResolveEventDateTimeOptions {
  /** IANA zone that naive wall-clock values are read in. Defaults to UTC. */
  timeZone?: string | null;
  /** All-day events are stored as UTC midnight of their calendar date. */
  allDay?: boolean;
}

/**
 * Whether `timeZone` is a zone the anchoring code can actually use.
 *
 * Probes with the same constructor used for anchoring: an unknown zone yields
 * an Invalid Date rather than a throw, so this never silently falls back to the
 * machine's own zone.
 */
export function isValidTimeZone(timeZone: string): boolean {
  if (UTC_OFFSET_ONLY.test(timeZone)) return false;
  const probe = new TZDate(2026, 0, 1, 0, 0, 0, timeZone);
  return !Number.isNaN(probe.getTime());
}

/** Throws a model-readable error when `timeZone` is not a usable zone. */
export function assertValidTimeZone(timeZone: string): string {
  if (!isValidTimeZone(timeZone)) {
    throw new Error(
      `Unknown timezone "${timeZone}". Use an IANA identifier such as "${EXAMPLE_TIME_ZONE}".`,
    );
  }
  return timeZone;
}

/** Whether `value` carries its own offset (`Z`, `+02:00`), making it absolute. */
export function hasExplicitOffset(value: string): boolean {
  return EXPLICIT_OFFSET.test(value.trim());
}

function componentsFromMatch(match: RegExpExecArray, source: string) {
  const [, year, month, day, hours = "00", minutes = "00", seconds = "00", ms = "0"] = match;
  const parsed = {
    year: Number(year),
    month: Number(month),
    day: Number(day),
    hours: Number(hours),
    minutes: Number(minutes),
    seconds: Number(seconds),
    ms: Number(ms.padEnd(3, "0")),
  };

  if (parsed.month < 1 || parsed.month > 12 || parsed.day < 1 || parsed.day > 31) {
    throw new Error(`Invalid date "${source}". Expected a real calendar date.`);
  }
  if (parsed.hours > 23 || parsed.minutes > 59 || parsed.seconds > 59) {
    throw new Error(`Invalid time in "${source}". Expected a 24-hour clock time.`);
  }
  const dateOnly = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day));
  if (
    dateOnly.getUTCMonth() !== parsed.month - 1 ||
    dateOnly.getUTCDate() !== parsed.day ||
    dateOnly.getUTCFullYear() !== parsed.year
  ) {
    throw new Error(`Invalid date "${source}": that day does not exist in that month.`);
  }
  return parsed;
}

/**
 * Parse an ISO 8601 datetime into the UTC instant it denotes.
 *
 * Values with an offset or `Z` are absolute and used as-is; a `timeZone` is
 * only kept as a label for them. Naive values are read as wall-clock time in
 * `options.timeZone`, or as UTC when none is given.
 */
export function resolveEventDateTime(
  value: string,
  options: ResolveEventDateTimeOptions = {},
): Date {
  const source = typeof value === "string" ? value.trim() : "";
  if (!source) {
    throw new Error("Missing datetime value. Expected ISO 8601, e.g. 2026-01-15T09:00:00.");
  }

  if (options.allDay) {
    const datePart = DATE_PART.exec(source);
    if (!datePart) {
      throw new Error(
        `Invalid all-day date "${value}". Expected an ISO date like 2026-01-15 (all-day events ignore time and offset).`,
      );
    }
    const { year, month, day } = componentsFromMatch(datePart, source);
    return new Date(Date.UTC(year, month - 1, day));
  }

  if (hasExplicitOffset(source)) {
    const absolute = new Date(source);
    if (Number.isNaN(absolute.getTime())) {
      throw new Error(
        `Invalid datetime "${value}". Expected ISO 8601, e.g. 2026-01-15T09:00:00+02:00.`,
      );
    }
    return absolute;
  }

  const match = WALL_CLOCK.exec(source);
  if (!match) {
    throw new Error(
      `Invalid datetime "${value}". Expected ISO 8601 with an offset (2026-01-15T09:00:00+02:00) or a wall-clock value (2026-01-15T09:00:00).`,
    );
  }
  const { year, month, day, hours, minutes, seconds, ms } = componentsFromMatch(match, source);

  const timeZone = options.timeZone ?? null;
  if (!timeZone || timeZone === "UTC") {
    return new Date(Date.UTC(year, month - 1, day, hours, minutes, seconds, ms));
  }

  assertValidTimeZone(timeZone);
  // TZDate shifts wall clocks that fall in a DST gap forward by the gap, and
  // resolves an ambiguous wall clock (clocks going back) to the offset that
  // applies after the transition.
  const zoned = new TZDate(year, month - 1, day, hours, minutes, seconds, ms, timeZone);
  if (Number.isNaN(zoned.getTime())) {
    throw new Error(`Could not anchor "${value}" in timezone "${timeZone}".`);
  }
  // Back to a plain Date: only ical-generator's serializer wants a TZDate.
  return new Date(zoned.getTime());
}

/**
 * A `TZDate` view of `date` on `timeZone`'s clock. Serializers that read local
 * getters (ical-generator) then emit the zone's wall time instead of the
 * machine's.
 */
export function toZonedDate(date: Date, timeZone: string): TZDate {
  assertValidTimeZone(timeZone);
  return new TZDate(date.getTime(), timeZone);
}

/**
 * The wall clock `date` reads on `timeZone`'s clock, as a naive ISO string.
 * Inverse of {@link resolveEventDateTime}. used to re-anchor times.
 */
export function formatWallClock(date: Date, timeZone: string): string {
  const zoned = toZonedDate(date, timeZone);
  return joinWallClock(
    zoned.getFullYear(),
    zoned.getMonth() + 1,
    zoned.getDate(),
    zoned.getHours(),
    zoned.getMinutes(),
    zoned.getSeconds(),
  );
}

/**
 * The wall clock this machine reads for `date`, as a naive ISO string.
 *
 * Inverts parsers that read a value on the machine's clock while keeping the
 * zone only as metadata (the `ical` package does this for TZID and date-only
 * values), so the wall clock can be re-anchored to the real zone.
 */
export function formatLocalWallClock(date: Date): string {
  return joinWallClock(
    date.getFullYear(),
    date.getMonth() + 1,
    date.getDate(),
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
  );
}

function joinWallClock(
  year: number,
  month: number,
  day: number,
  hours: number,
  minutes: number,
  seconds: number,
): string {
  const pad = (value: number, length = 2) => String(value).padStart(length, "0");
  return (
    `${pad(year, 4)}-${pad(month)}-${pad(day)}` + `T${pad(hours)}:${pad(minutes)}:${pad(seconds)}`
  );
}

/**
 * Keep the local time but read it on another zone's clock: a 09:00 Athens
 * meeting becomes 09:00 Tokyo, not 16:00 Tokyo.
 */
export function moveToTimeZone(date: Date, fromTimeZone: string, toTimeZone: string): Date {
  return resolveEventDateTime(formatWallClock(date, fromTimeZone), { timeZone: toTimeZone });
}
