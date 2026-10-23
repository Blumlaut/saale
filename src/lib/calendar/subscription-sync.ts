import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { parseICS, type ParsedEvent } from "./ics-import";

/**
 * The shared columns written for a subscription event, create and update alike.
 */
function subscriptionEventData(evt: ParsedEvent) {
  return {
    summary: evt.summary,
    description: evt.description ?? null,
    location: evt.location ?? null,
    url: evt.url ?? null,
    status: evt.status ?? null,
    transparency: evt.transparency ?? null,
    sequence: evt.sequence,
    dtStart: evt.dtStart,
    dtEnd: evt.dtEnd ?? null,
    allDay: evt.allDay,
    timeZone: evt.timeZone ?? null,
    recurrenceRule: evt.recurrenceRule ?? null,
    alerts: evt.alerts ? JSON.stringify(evt.alerts) : null,
  };
}

/** Postgres bind-parameter headroom for `in` lists (the cap is 65535). */
const UIDS_PER_QUERY = 5000;
/** createMany binds every column of every row (16 here); keep batches far under 65535. */
const CREATE_BATCH_SIZE = 1000;

/**
 * Fetch a remote ICS URL and merge events into the target calendar.
 * Uses ETag for conditional fetch (304 = no changes).
 * Requires userId for ownership validation (defense in depth).
 */
export async function syncSubscription(
  subscriptionId: string,
  userId: string,
): Promise<{
  eventsCreated: number;
  eventsUpdated: number;
  eventsDeleted: number;
  parsedEvents: number;
  error: string | null;
}> {
  const subscription = await prisma.calendarSubscription.findFirst({
    where: { id: subscriptionId, userId },
    include: { calendar: { include: { account: true } } },
  });

  if (!subscription || !subscription.enabled) {
    return {
      eventsCreated: 0,
      eventsUpdated: 0,
      eventsDeleted: 0,
      parsedEvents: 0,
      error: "Subscription not found or disabled",
    };
  }

  // Fetch remote ICS
  let icsContent: string;
  let newEtag: string | null = null;

  try {
    const fetchOptions: RequestInit = {
      headers: {
        Accept: "text/calendar",
      },
    };

    if (subscription.etag) {
      (fetchOptions.headers as Record<string, string>)["If-None-Match"] = subscription.etag;
    }

    // Add auth if provided
    if (subscription.username && subscription.password) {
      const password = decrypt(subscription.password ?? "");
      (fetchOptions.headers as Record<string, string>)["Authorization"] =
        "Basic " + btoa(`${subscription.username}:${password}`);
    }

    const response = await fetch(subscription.url, fetchOptions);

    if (response.status === 304) {
      // No changes
      return {
        eventsCreated: 0,
        eventsUpdated: 0,
        eventsDeleted: 0,
        parsedEvents: 0,
        error: null,
      };
    }

    if (!response.ok) {
      return {
        eventsCreated: 0,
        eventsUpdated: 0,
        eventsDeleted: 0,
        parsedEvents: 0,
        error: `HTTP ${response.status}: ${response.statusText}`,
      };
    }

    icsContent = await response.text();
    newEtag = response.headers.get("etag")?.replace(/"/g, "") ?? null;

    // Validate: ICS content should start with BEGIN:VCALENDAR
    const trimmedContent = icsContent.trim();
    if (!trimmedContent.startsWith("BEGIN:VCALENDAR")) {
      const preview = trimmedContent.slice(0, 200).replace(/\n/g, " ");
      return {
        eventsCreated: 0,
        eventsUpdated: 0,
        eventsDeleted: 0,
        parsedEvents: 0,
        error: `Not a valid ICS file (got: ${preview})`,
      };
    }
  } catch (err) {
    return {
      eventsCreated: 0,
      eventsUpdated: 0,
      eventsDeleted: 0,
      parsedEvents: 0,
      error: err instanceof Error ? err.message : "Failed to fetch ICS",
    };
  }

  // Parse ICS
  const parsedEvents = parseICS(icsContent);

  // A malformed ICS may carry the same UID twice; the last occurrence wins.
  // The old sequential loop created on the first and updated on the second.
  const eventsByUid = new Map<string, ParsedEvent>();
  for (const evt of parsedEvents) {
    eventsByUid.set(evt.uid, evt);
  }
  const events = Array.from(eventsByUid.values());

  // Which UIDs already have a row in this calendar (any source, matching the
  // old findUnique on calendarId_uid). One query per chunk of UIDs instead of
  // one per event. A large yearly subscription used to mean thousands of
  // round trips per sync.
  const existingByUid = new Map<string, string>();
  for (let i = 0; i < events.length; i += UIDS_PER_QUERY) {
    const existing = await prisma.calendarEvent.findMany({
      where: {
        calendarId: subscription.calendarId,
        uid: { in: events.slice(i, i + UIDS_PER_QUERY).map((e) => e.uid) },
      },
      select: { uid: true, id: true },
    });
    for (const row of existing) {
      existingByUid.set(row.uid, row.id);
    }
  }

  const toCreate = events.filter((evt) => !existingByUid.has(evt.uid));
  const toUpdate = events.filter((evt) => existingByUid.has(evt.uid));

  for (let i = 0; i < toCreate.length; i += CREATE_BATCH_SIZE) {
    await prisma.calendarEvent.createMany({
      data: toCreate.slice(i, i + CREATE_BATCH_SIZE).map((evt) => ({
        calendarId: subscription.calendarId,
        uid: evt.uid,
        ...subscriptionEventData(evt),
        source: "subscription",
      })),
    });
  }

  let updated = 0;
  for (const evt of toUpdate) {
    const id = existingByUid.get(evt.uid);
    if (!id) continue;
    await prisma.calendarEvent.update({
      where: { id },
      data: {
        ...subscriptionEventData(evt),
        source: "subscription",
      },
    });
    updated++;
  }

  const created = toCreate.length;

  // Delete events that are no longer in the ICS
  const currentUids = new Set(parsedEvents.map((e) => e.uid));
  const existingEvents = await prisma.calendarEvent.findMany({
    where: {
      calendarId: subscription.calendarId,
      source: "subscription",
    },
    select: { uid: true },
  });

  const toDelete = existingEvents.filter((e) => !currentUids.has(e.uid));
  if (toDelete.length > 0) {
    await prisma.calendarEvent.deleteMany({
      where: {
        calendarId: subscription.calendarId,
        source: "subscription",
        uid: { in: toDelete.map((e) => e.uid) },
      },
    });
  }

  // Update subscription metadata
  await prisma.calendarSubscription.update({
    where: { id: subscriptionId },
    data: {
      lastSyncedAt: new Date(),
      etag: newEtag,
    },
  });

  return {
    eventsCreated: created,
    eventsUpdated: updated,
    eventsDeleted: toDelete.length,
    parsedEvents: parsedEvents.length,
    error: null,
  };
}

/**
 * Sync all enabled subscriptions for a user.
 */
export async function syncAllSubscriptions(userId: string): Promise<{
  totalCreated: number;
  totalUpdated: number;
  totalDeleted: number;
  errors: string[];
}> {
  const subscriptions = await prisma.calendarSubscription.findMany({
    where: {
      userId,
      enabled: true,
    },
  });

  let totalCreated = 0;
  let totalUpdated = 0;
  let totalDeleted = 0;
  const errors: string[] = [];

  for (const sub of subscriptions) {
    const result = await syncSubscription(sub.id, userId);
    totalCreated += result.eventsCreated;
    totalUpdated += result.eventsUpdated;
    totalDeleted += result.eventsDeleted;
    if (result.error) {
      errors.push(`${sub.name}: ${result.error}`);
    }
  }

  return { totalCreated, totalUpdated, totalDeleted, errors };
}
