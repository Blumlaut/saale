import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { parseICS } from "./ics-import";

/**
 * Fetch a remote ICS URL and merge events into the target calendar.
 * Uses ETag for conditional fetch (304 = no changes).
 */
export async function syncSubscription(subscriptionId: string): Promise<{
  eventsCreated: number;
  eventsUpdated: number;
  eventsDeleted: number;
  parsedEvents: number;
  error: string | null;
}> {
  const subscription = await prisma.calendarSubscription.findUnique({
    where: { id: subscriptionId },
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

  let created = 0;
  let updated = 0;

  for (const evt of parsedEvents) {
    const existing = await prisma.calendarEvent.findUnique({
      where: {
        calendarId_uid: {
          calendarId: subscription.calendarId,
          uid: evt.uid,
        },
      },
    });

    if (existing) {
      // Update existing event
      await prisma.calendarEvent.update({
        where: { id: existing.id },
        data: {
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
          source: "subscription",
        },
      });
      updated++;
    } else {
      // Create new event
      await prisma.calendarEvent.create({
        data: {
          calendarId: subscription.calendarId,
          uid: evt.uid,
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
          source: "subscription",
        },
      });
      created++;
    }
  }

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
    const result = await syncSubscription(sub.id);
    totalCreated += result.eventsCreated;
    totalUpdated += result.eventsUpdated;
    totalDeleted += result.eventsDeleted;
    if (result.error) {
      errors.push(`${sub.name}: ${result.error}`);
    }
  }

  return { totalCreated, totalUpdated, totalDeleted, errors };
}
