/**
 * Calendar event reminders.
 *
 * A sweep rather than a scheduled push per event: an event's times change when
 * its calendar syncs, and a reminder already queued for a moved or deleted
 * event would fire anyway. Looking at the upcoming events every minute and
 * reminding for the ones that have come due is self-correcting.
 *
 * `remindedAt` is what keeps a reminder to one per event. It is set for every
 * event the sweep decides about, including the ones no device wanted. the row
 * must not be reconsidered every minute.
 */
import { prisma } from "@/lib/db";
import { notifyUser } from "./notify";

/** Lead time when an event carries no alert of its own. */
export const DEFAULT_REMINDER_MINUTES = 15;

/**
 * How far ahead the sweep looks. Generous on purpose: a calendar app can store
 * an alert of an hour or a day before the event, and this window decides which
 * events are even considered.
 */
const SCAN_WINDOW_MINUTES = 24 * 60;

/** An event's `alerts` column: [{ triggerMinutes, action }]. */
interface EventAlert {
  triggerMinutes?: unknown;
  action?: unknown;
}

/**
 * Minutes before the event to remind, from its own alerts.
 *
 * Takes the earliest alert the user configured; a calendar can hold several
 * (5 minutes for a nudge, 60 for a heads-up) and only the first one matters.
 */
export function reminderLeadMinutes(alerts: string | null): number {
  if (!alerts) return DEFAULT_REMINDER_MINUTES;

  let parsed: unknown;
  try {
    parsed = JSON.parse(alerts);
  } catch (err) {
    console.error("Failed to parse a calendar event's alerts:", err);
    return DEFAULT_REMINDER_MINUTES;
  }

  if (!Array.isArray(parsed)) return DEFAULT_REMINDER_MINUTES;

  const triggers = (parsed as EventAlert[])
    .map((alert) => alert?.triggerMinutes)
    .filter(
      (minutes): minutes is number =>
        typeof minutes === "number" && Number.isFinite(minutes) && minutes >= 0,
    );

  if (triggers.length === 0) return DEFAULT_REMINDER_MINUTES;

  return Math.min(...triggers, SCAN_WINDOW_MINUTES);
}

/** "In 12 minutes" / "Starting now", which needs no timezone to be right. */
export function describeLead(minutesUntilStart: number): string {
  const minutes = Math.max(0, Math.round(minutesUntilStart));
  if (minutes === 0) return "Starting now";
  if (minutes === 1) return "Starting in 1 minute";
  return `Starting in ${minutes} minutes`;
}

export interface CalendarReminderSweep {
  /** Upcoming events the sweep looked at. */
  scanned: number;
  /** Events whose reminder came due. */
  due: number;
  /** Reminders actually delivered to at least one device or the bell. */
  notified: number;
}

/**
 * Remind users about the events that are due for one.
 *
 * Never throws for a single event: one misconfigured calendar must not stop
 * every other user's reminders.
 */
export async function sendCalendarReminders(now = new Date()): Promise<CalendarReminderSweep> {
  const horizon = new Date(now.getTime() + SCAN_WINDOW_MINUTES * 60_000);
  const result: CalendarReminderSweep = { scanned: 0, due: 0, notified: 0 };

  const events = await prisma.calendarEvent.findMany({
    where: {
      remindedAt: null,
      // An all-day event's start is a date, so a lead-time reminder for it
      // would fire at midnight. It gets no reminder.
      allDay: false,
      dtStart: { gt: now, lte: horizon },
      OR: [{ status: null }, { status: { not: "CANCELLED" } }],
      calendar: { enabled: true, account: { enabled: true } },
    },
    select: {
      id: true,
      summary: true,
      dtStart: true,
      location: true,
      alerts: true,
      calendar: { select: { account: { select: { userId: true } } } },
    },
    orderBy: { dtStart: "asc" },
  });

  result.scanned = events.length;
  const handled: string[] = [];

  for (const event of events) {
    const leadMinutes = reminderLeadMinutes(event.alerts);
    const reminderAt = event.dtStart.getTime() - leadMinutes * 60_000;
    if (reminderAt > now.getTime()) continue;

    const minutesUntilStart = (event.dtStart.getTime() - now.getTime()) / 60_000;
    const userId = event.calendar.account.userId;

    result.due++;
    handled.push(event.id);

    try {
      await notifyUser({
        userId,
        category: "calendar",
        title: event.summary,
        body: [describeLead(minutesUntilStart), event.location?.trim()].filter(Boolean).join(" · "),
        url: "/dashboard/calendar",
        tag: `event-${event.id}`,
        inApp: true,
      });
      result.notified++;
    } catch (err) {
      console.error(`Failed to remind user ${userId} about event ${event.id}:`, err);
    }
  }

  if (handled.length > 0) {
    // A reminder that could not be delivered is still spent: a phone that was
    // offline at the reminder time must not get it a day later.
    await prisma.calendarEvent.updateMany({
      where: { id: { in: handled }, remindedAt: null },
      data: { remindedAt: now },
    });
  }

  return result;
}
