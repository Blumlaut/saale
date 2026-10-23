import type { DAVClient } from "tsdav";
import type { DAVCalendar, DAVCalendarObject } from "tsdav";
import { prisma } from "@/lib/db";
import { chunk, IN_LIST_CHUNK_SIZE } from "@/lib/db-batch";
import { connectCalDAV } from "./caldav";
import { parseICS, type ParsedEvent } from "./ics-import";

/**
 * Sync a single calendar account from CalDAV.
 * Uses incremental sync when a syncToken is available, falls back to full sync.
 */
export async function syncCalendarAccount(accountId: string): Promise<{
  calendarsSynced: number;
  eventsCreated: number;
  eventsUpdated: number;
  eventsDeleted: number;
  errors: string[];
}> {
  const account = await prisma.calendarAccount.findUnique({
    where: { id: accountId },
  });

  if (!account || !account.enabled) {
    throw new Error(`Calendar account ${accountId} not found or disabled`);
  }

  let eventsCreated = 0;
  let eventsUpdated = 0;
  let eventsDeleted = 0;
  const errors: string[] = [];

  try {
    const { client } = await connectCalDAV(accountId);

    // Step 1: Fetch all remote calendars
    const remoteCalendars = await client.fetchCalendars();
    // eslint-disable-next-line no-console
    console.log(
      `[calendar-sync] Account ${accountId}: found ${remoteCalendars.length} remote calendars`,
    );

    let calendarsSynced = 0;

    for (const remoteCal of remoteCalendars) {
      try {
        // Step 2: Upsert the Calendar record
        const localCalendar = await prisma.calendar.upsert({
          where: {
            accountId_remoteId: {
              accountId,
              remoteId: remoteCal.url || "",
            },
          },
          update: {
            name: (remoteCal.displayName as string) || remoteCal.url || "Unnamed",
            color: remoteCal.calendarColor ?? null,
            description: remoteCal.description ?? null,
            ctag: remoteCal.ctag ?? null,
            syncToken: remoteCal.syncToken ?? null,
          },
          create: {
            accountId,
            remoteId: remoteCal.url || "",
            name: (remoteCal.displayName as string) || remoteCal.url || "Unnamed",
            color: remoteCal.calendarColor ?? null,
            description: remoteCal.description ?? null,
            ctag: remoteCal.ctag ?? null,
            syncToken: remoteCal.syncToken ?? null,
          },
        });

        if (!localCalendar.enabled) continue;

        // Step 3: Sync events (incremental if syncToken exists, else full)
        const result = await syncCalendarEvents(client, localCalendar);
        eventsCreated += result.created;
        eventsUpdated += result.updated;
        eventsDeleted += result.deleted;

        calendarsSynced++;
      } catch (err) {
        const calErr = err as Error;
        console.error(`[calendar-sync] Failed to sync calendar ${remoteCal.url}:`, calErr.message);
        errors.push(`Failed to sync calendar "${remoteCal.displayName}": ${calErr.message}`);
      }
    }

    // Update account lastSyncedAt
    await prisma.calendarAccount.update({
      where: { id: accountId },
      data: { lastSyncedAt: new Date() },
    });

    // eslint-disable-next-line no-console
    console.log(
      `[calendar-sync] Account ${accountId} done: ${calendarsSynced} calendars, ` +
        `${eventsCreated} created, ${eventsUpdated} updated, ${eventsDeleted} deleted, ` +
        `${errors.length} errors`,
    );

    return {
      calendarsSynced,
      eventsCreated,
      eventsUpdated,
      eventsDeleted,
      errors,
    };
  } catch (err) {
    const connErr = err as Error;
    console.error(`[calendar-sync] Connection error for ${accountId}:`, connErr.message);
    errors.push(`Connection error: ${connErr.message}`);
    return {
      calendarsSynced: 0,
      eventsCreated: 0,
      eventsUpdated: 0,
      eventsDeleted: 0,
      errors,
    };
  }
}

/**
 * Sync events for a single calendar.
 * Uses incremental sync (smartCollectionSyncDetailed) when syncToken is available.
 */
async function syncCalendarEvents(
  client: DAVClient,
  calendar: Awaited<ReturnType<typeof prisma.calendar.findUnique>>,
): Promise<{ created: number; updated: number; deleted: number }> {
  if (!calendar) throw new Error("Calendar not found");

  let created = 0;
  let updated = 0;
  let deleted = 0;

  // Build a DAVCalendar object from our local record
  const davCalendar: DAVCalendar = {
    url: calendar.remoteId!,
    displayName: calendar.name,
    ...(calendar.ctag ? { ctag: calendar.ctag } : {}),
    ...(calendar.syncToken ? { syncToken: calendar.syncToken } : {}),
    ...(calendar.color ? { calendarColor: calendar.color } : {}),
    ...(calendar.description ? { description: calendar.description } : {}),
  };

  // Try incremental sync first
  if (calendar.syncToken) {
    try {
      const result = await client.smartCollectionSyncDetailed({
        collection: davCalendar,
        method: "webdav",
      });

      // Process deleted URLs
      if (result.objects.deleted?.length) {
        for (const deletedObj of result.objects.deleted) {
          // Find event by URL suffix (UID mapping)
          const uid = extractUIDFromUrl(deletedObj.url);
          if (uid) {
            await prisma.calendarEvent.deleteMany({
              where: {
                calendarId: calendar.id,
                uid,
              },
            });
            deleted++;
          }
        }
      }

      // Process created/updated URLs
      const changedObjs = [...(result.objects.created ?? []), ...(result.objects.updated ?? [])];

      const pairs: Array<{ evt: ParsedEvent; obj: DAVCalendarObject }> = [];
      for (const changedObj of changedObjs) {
        const object = await fetchSingleObject(client, davCalendar, changedObj.url);
        if (!object?.data) continue;

        for (const evt of parseICS(object.data)) {
          pairs.push({ evt, obj: object });
        }
      }

      const outcome = await upsertCalendarEvents(calendar.id, pairs);
      created += outcome.created;
      updated += outcome.updated;

      // Update syncToken
      if (result.syncToken) {
        await prisma.calendar.update({
          where: { id: calendar.id },
          data: {
            syncToken: result.syncToken,
            ctag: result.ctag ?? null,
            lastSyncedAt: new Date(),
          },
        });
      }

      return { created, updated, deleted };
    } catch (err) {
      const syncErr = err as Error;
      console.warn(
        `[calendar-sync] Incremental sync failed for ${calendar.id}, falling back to full sync:`,
        syncErr.message,
      );
      // Fall through to full sync
    }
  }

  // Full sync: fetch all objects
  const objects = await client.fetchCalendarObjects({
    calendar: davCalendar,
  });

  const pairs: Array<{ evt: ParsedEvent; obj: DAVCalendarObject }> = [];
  for (const obj of objects) {
    if (!obj?.data) continue;

    for (const evt of parseICS(obj.data)) {
      pairs.push({ evt, obj });
    }
  }

  const outcome = await upsertCalendarEvents(calendar.id, pairs);
  created += outcome.created;
  updated += outcome.updated;

  // Update calendar metadata
  await prisma.calendar.update({
    where: { id: calendar.id },
    data: {
      ctag: davCalendar.ctag ?? null,
      lastSyncedAt: new Date(),
    },
  });

  return { created, updated, deleted };
}

/**
 * Fetch a single calendar object by URL.
 */
async function fetchSingleObject(
  client: DAVClient,
  calendar: DAVCalendar,
  url: string,
): Promise<DAVCalendarObject | null> {
  const objects = await client.fetchCalendarObjects({
    calendar,
    objectUrls: [url],
  });
  return objects[0] || null;
}

/**
 * Extract UID from a CalDAV object URL.
 * URLs typically look like: .../calendars/user/abc123.ics
 */
function extractUIDFromUrl(url: string): string | null {
  const match = url.match(/\/([^/]+)\.ics$/);
  return match?.[1] || null;
}

/** createMany binds every column of every row (19 here); keep batches far under the cap. */
const CREATE_BATCH_SIZE = 1000;

/**
 * Upsert a batch of parsed events for one calendar (used by both incremental
 * and full sync) in as few round trips as possible: one existence lookup per
 * chunk of UIDs, one createMany per chunk of new rows, one update per row
 * whose sequence actually advanced. The old per-event loop made two queries
 * per event, which dominated a full sync of a busy calendar.
 *
 * A UID that appears in several objects is written once, last occurrence
 * winning (the old sequential loop ended in the same state).
 */
async function upsertCalendarEvents(
  calendarId: string,
  pairs: Array<{ evt: ParsedEvent; obj: DAVCalendarObject }>,
): Promise<{ created: number; updated: number }> {
  const byUid = new Map<string, { evt: ParsedEvent; obj: DAVCalendarObject }>();
  for (const pair of pairs) {
    byUid.set(pair.evt.uid, pair);
  }
  const events = Array.from(byUid.values());

  // Existing rows with their sequence, for the "skip unless advanced" check.
  const existing = new Map<string, { id: string; sequence: number }>();
  for (const uidBatch of chunk(
    events.map((e) => e.evt.uid),
    IN_LIST_CHUNK_SIZE,
  )) {
    const rows = await prisma.calendarEvent.findMany({
      where: { calendarId, uid: { in: uidBatch } },
      select: { uid: true, id: true, sequence: true },
    });
    for (const row of rows) {
      existing.set(row.uid, { id: row.id, sequence: row.sequence });
    }
  }

  const toCreate: Array<{ data: ReturnType<typeof buildEventData> }> = [];
  const toUpdate: Array<{ id: string; data: ReturnType<typeof buildEventData> }> = [];

  for (const { evt, obj } of events) {
    const data = buildEventData(evt, obj);
    const row = existing.get(evt.uid);
    if (!row) {
      toCreate.push({ data });
    } else if (data.sequence > row.sequence) {
      toUpdate.push({ id: row.id, data });
    }
  }

  for (const batch of chunk(toCreate, CREATE_BATCH_SIZE)) {
    await prisma.calendarEvent.createMany({
      data: batch.map((entry) => ({ ...entry.data, calendarId })),
    });
  }

  let updated = 0;
  for (const { id, data } of toUpdate) {
    await prisma.calendarEvent.update({ where: { id }, data });
    updated++;
  }

  return { created: toCreate.length, updated };
}

/**
 * Build CalendarEvent data from a parsed event and its remote object.
 */
function buildEventData(
  evt: ParsedEvent,
  obj: DAVCalendarObject,
): {
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
  alerts: string | null;
  etag: string | null;
  lastModified: Date;
  source: string;
} {
  return {
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
    etag: obj.etag?.replace(/"/g, "") ?? null,
    lastModified: new Date(),
    source: "caldav",
  };
}
