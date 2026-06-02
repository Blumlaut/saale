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

  const password = account.authMethod === "basic" ? decrypt(account.encryptedPassword) : null;

  const credentials =
    account.authMethod === "basic"
      ? { username: account.username, password: password! }
      : { accessToken: account.accessToken ?? "" };

  const client = new DAVClient({
    serverUrl: account.serverUrl,
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
 * Push a new event to a CalDAV calendar.
 * Generates a VCALENDAR string and calls createCalendarObject.
 */
export async function pushEventToCalDAV(
  calendarId: string,
  event: ICSExportEvent,
): Promise<PushResult> {
  try {
    const calendar = await prisma.calendar.findUnique({
      where: { id: calendarId },
      include: { account: true },
    });
    if (!calendar || !calendar.remoteId) {
      return {
        success: false,
        remoteUrl: null,
        etag: null,
        error: "Calendar is not a CalDAV calendar",
      };
    }

    const { client } = await connectCalDAV(calendar.accountId);
    const remoteCalendars = await client.fetchCalendars();
    const remoteCalendar = remoteCalendars.find(
      (c) =>
        c.url === calendar.remoteId ||
        c.url.endsWith(calendar.remoteId!) ||
        calendar.remoteId?.endsWith(c.url),
    );
    if (!remoteCalendar) {
      return {
        success: false,
        remoteUrl: null,
        etag: null,
        error: `Remote calendar ${calendar.remoteId} not found`,
      };
    }

    const ics = generateICS(event);
    const response = await client.createCalendarObject({
      calendar: remoteCalendar,
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
    const calendar = await prisma.calendar.findUnique({
      where: { id: calendarId },
      include: { account: true },
    });
    if (!calendar || !calendar.remoteId) {
      return { success: false, etag: null, error: "Calendar is not a CalDAV calendar" };
    }
    if (!event.url) {
      return { success: false, etag: null, error: "No remote URL for event" };
    }

    const { client } = await connectCalDAV(calendar.accountId);

    const ics = generateICS(event);
    const response = await client.updateCalendarObject({
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
    const calendar = await prisma.calendar.findUnique({
      where: { id: calendarId },
      include: { account: true },
    });
    if (!calendar || !calendar.remoteId) {
      return { success: false, error: "Calendar is not a CalDAV calendar" };
    }

    const { client } = await connectCalDAV(calendar.accountId);

    await client.deleteCalendarObject({
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
