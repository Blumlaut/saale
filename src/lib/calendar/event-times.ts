import { DEFAULT_EVENT_DURATION_MS } from "./ics-export";
import { assertValidTimeZone, moveToTimeZone, resolveEventDateTime } from "./timezone";

/**
 * Resolving event times for the write paths (agent tools and HTTP routes).
 *
 * Both entry points accept the same time fields, so the anchoring rules live
 * here once: a naive datetime is read in the event's timezone, an absolute one
 * is stored as-is, and an unknown timezone is an error rather than a silent
 * UTC fallback.
 */

export interface EventTimeFields {
  dtStart?: string | null | undefined;
  dtEnd?: string | null | undefined;
  /** `null` clears the timezone, `undefined` leaves it untouched. */
  timeZone?: string | null | undefined;
  allDay?: boolean | undefined;
}

export interface ExistingEventTimes {
  dtStart: Date;
  dtEnd: Date | null;
  timeZone: string | null;
  allDay: boolean;
}

export interface ResolvedEventTimes {
  dtStart: Date;
  dtEnd: Date | null;
  timeZone: string | null;
}

export interface EventTimeUpdate {
  dtStart?: Date;
  dtEnd?: Date | null;
  timeZone?: string | null;
}

function normalizeTimeZone(timeZone: string | null | undefined): string | null {
  if (timeZone === undefined || timeZone === null || timeZone === "") return null;
  return assertValidTimeZone(timeZone);
}

/** Resolve the time fields of a new event. */
export function resolveNewEventTimes(
  fields: EventTimeFields & { dtStart: string },
): ResolvedEventTimes {
  const allDay = fields.allDay ?? false;
  const timeZone = normalizeTimeZone(fields.timeZone);
  return {
    dtStart: resolveEventDateTime(fields.dtStart, { timeZone, allDay }),
    dtEnd: fields.dtEnd ? resolveEventDateTime(fields.dtEnd, { timeZone, allDay }) : null,
    timeZone,
  };
}

/**
 * Resolve an update's time fields against the stored event.
 *
 * A supplied `dtStart`/`dtEnd` is anchored in the (possibly new) timezone.
 * Changing only the timezone keeps the local time and moves the event, the way
 * other calendar apps treat "move this event to another timezone".
 */
export function resolveEventTimeUpdate(
  current: ExistingEventTimes,
  fields: EventTimeFields,
): EventTimeUpdate {
  const allDay = fields.allDay ?? current.allDay;
  const timeZone =
    fields.timeZone === undefined ? current.timeZone : normalizeTimeZone(fields.timeZone);
  const timeZoneChanged = fields.timeZone !== undefined && timeZone !== current.timeZone;

  const update: EventTimeUpdate = {};
  if (fields.timeZone !== undefined) update.timeZone = timeZone;

  if (fields.dtStart !== undefined && fields.dtStart !== null) {
    update.dtStart = resolveEventDateTime(fields.dtStart, { timeZone, allDay });
  } else if (timeZoneChanged && timeZone) {
    const movedStart = moveToTimeZone(current.dtStart, current.timeZone ?? "UTC", timeZone);
    update.dtStart = movedStart;
    if (current.dtEnd) {
      // Keep the duration: the wall clock moves, the length does not.
      const duration = current.dtEnd.getTime() - current.dtStart.getTime();
      update.dtEnd = new Date(movedStart.getTime() + duration);
    }
  }

  if (fields.dtEnd !== undefined) {
    update.dtEnd = fields.dtEnd ? resolveEventDateTime(fields.dtEnd, { timeZone, allDay }) : null;
  }

  return update;
}

/** Start + the default event length, for events created without an end. */
export function defaultEventEnd(dtStart: Date): Date {
  return new Date(dtStart.getTime() + DEFAULT_EVENT_DURATION_MS);
}
