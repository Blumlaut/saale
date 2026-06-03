import { DAVClient } from "tsdav";
import type { DAVCalendar, DAVCalendarObject } from "tsdav";
import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { generateICS, type ICSExportEvent } from "./ics-export";

interface PushResult {
  success: boolean;
  remoteUrl: string | null;
  etag: string | null;
  error: string | null;
}

interface UpdateResult {
  success: boolean;
  etag: string | null;
  error: string | null;
}

interface DeleteResult {
  success: boolean;
  error: string | null;
}

/**
 * Connect to a CalDAV server for a calendar account.
 * Returns a DAVClient instance — caller is responsible for cleanup.
 */
export async function connectCalDAV(accountId: string): Promise<{
  client: DAVClient;
  account: Awaited<ReturnType<typeof prisma.calendarAccount.findUnique>>;
}> {
  const account = await prisma.calendarAccount.findUnique({
    where: { id: accountId },
  });
  if (!account) throw new Error(`Calendar account ${accountId} not found`);
  if (account.accountType === "local") {
    throw new Error("Cannot connect CalDAV client to a local account");
  }

  const password = account.authMethod === "basic" ? decrypt(account.encryptedPassword ?? "") : null;

  const credentials =
    account.authMethod === "basic"
      ? { username: account.username ?? "", password: password ?? "" }
      : { accessToken: account.accessToken ?? "" };

  const client = new DAVClient({
    serverUrl: account.serverUrl ?? "",
    credentials,
    authMethod: account.authMethod === "basic" ? "Basic" : "Bearer",
    defaultAccountType: "caldav",
  });

  await client.login();
  return { client, account };
}

/**
 * Discover remote calendars for an account.
 * Returns DAVCalendar[] from the CalDAV server.
 */
export async function discoverCalendars(accountId: string): Promise<DAVCalendar[]> {
  const { client } = await connectCalDAV(accountId);
  try {
    return await client.fetchCalendars();
  } finally {
    // DAVClient doesn't have an explicit logout, but we let the connection idle
  }
}

/**
 * Resolve a calendar by ID and connect to its CalDAV server.
 */
async function resolveCalDAVClient(
  calendarId: string,
): Promise<
  | { ok: true; calendar: NonNullable<Awaited<ReturnType<typeof prisma.calendar.findUnique>>>; client: DAVClient }
  | { ok: false; error: string }
> {
  const calendar = await prisma.calendar.findUnique({
    where: { id: calendarId },
    include: { account: true },
  });
  if (!calendar || !calendar.remoteId) {
    return { ok: false, error: "Calendar is not a CalDAV calendar" };
  }

  const { client } = await connectCalDAV(calendar.accountId);
  return { ok: true, calendar, client };
}

/**
 * Resolve a calendar by ID and connect to its CalDAV server.
 * Returns the calendar, client, and matched remote calendar.
 */
async function resolveCalDAVCalendar(
  calendarId: string,
): Promise<
  | { ok: true; calendar: NonNullable<Awaited<ReturnType<typeof prisma.calendar.findUnique>>>; client: DAVClient; remote: DAVCalendar }
  | { ok: false; error: string }
> {
  const base = await resolveCalDAVClient(calendarId);
  if (!base.ok) return base;

  const remoteCalendars = await base.client.fetchCalendars();
  const remote = remoteCalendars.find(
    (c) =>
      c.url === base.calendar.remoteId ||
      c.url.endsWith(base.calendar.remoteId!) ||
      base.calendar.remoteId?.endsWith(c.url),
  );
  if (!remote) {
    return { ok: false, error: `Remote calendar ${base.calendar.remoteId} not found` };
  }

  return { ok: true, calendar: base.calendar, client: base.client, remote };
}

/**
 * Push a new event to a CalDAV calendar.
 * Generates a VCALENDAR string and calls createCalendarObject.
 */
export async function pushEventToCalDAV(
  calendarId: string,
  event: ICSExportEvent,
): Promise<PushResult> {
  try {
    const result = await resolveCalDAVCalendar(calendarId);
    if (!result.ok) {
      return { success: false, remoteUrl: null, etag: null, error: result.error };
    }

    const ics = generateICS(event);
    const response = await result.client.createCalendarObject({
      calendar: result.remote,
      iCalString: ics,
      filename: `${event.uid}.ics`,
    });

    const etagRaw = (response.headers as unknown as Record<string, string>)?.etag;
    return {
      success: true,
      remoteUrl: response.url,
      etag: etagRaw?.replace(/"/g, "") ?? null,
      error: null,
    };
  } catch (err) {
    return {
      success: false,
      remoteUrl: null,
      etag: null,
      error: err instanceof Error ? err.message : "Unknown error pushing event",
    };
  }
}

/**
 * Update an existing event on a CalDAV calendar.
 */
export async function pushUpdateToCalDAV(
  calendarId: string,
  event: ICSExportEvent & { url?: string; sequence?: number },
): Promise<UpdateResult> {
  try {
    const resolved = await resolveCalDAVClient(calendarId);
    if (!resolved.ok) {
      return { success: false, etag: null, error: resolved.error };
    }
    if (!event.url) {
      return { success: false, etag: null, error: "No remote URL for event" };
    }

    const ics = generateICS(event);
    const response = await resolved.client.updateCalendarObject({
      calendarObject: {
        url: event.url,
        data: ics,
      } as DAVCalendarObject,
    });

    const etagRaw = (response.headers as unknown as Record<string, string>)?.etag;
    return {
      success: true,
      etag: etagRaw?.replace(/"/g, "") ?? null,
      error: null,
    };
  } catch (err) {
    return {
      success: false,
      etag: null,
      error: err instanceof Error ? err.message : "Unknown error updating event",
    };
  }
}

/**
 * Delete an event from a CalDAV calendar.
 */
export async function pushDeleteToCalDAV(
  calendarId: string,
  eventUrl: string,
): Promise<DeleteResult> {
  try {
    const resolved = await resolveCalDAVClient(calendarId);
    if (!resolved.ok) {
      return { success: false, error: resolved.error };
    }

    await resolved.client.deleteCalendarObject({
      calendarObject: {
        url: eventUrl,
      } as DAVCalendarObject,
    });

    return { success: true, error: null };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Unknown error deleting event",
    };
  }
}
