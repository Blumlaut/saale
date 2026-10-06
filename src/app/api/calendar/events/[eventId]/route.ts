import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireCalendarEventOwner } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { pushUpdateToCalDAV, pushDeleteToCalDAV } from "@/lib/calendar/caldav";
import { resolveEventTimeUpdate } from "@/lib/calendar/event-times";
import type { ICSExportEvent } from "@/lib/calendar/ics-export";

/**
 * GET /api/calendar/events/:eventId — Get a single event
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ eventId: string }> },
) {
  const { eventId } = await params;

  const authResult = await requireCalendarEventOwner(eventId);
  if (!authResult.ok) return authResult.response;
  const event = authResult.event;

  // Fetch calendar details for response
  const calendar = await prisma.calendar.findUnique({
    where: { id: event.calendarId },
    select: { id: true, name: true, color: true },
  });
  if (!calendar) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json({
    event: {
      id: event.id,
      uid: event.uid,
      calendarId: event.calendarId,
      calendarName: calendar.name,
      calendarColor: calendar.color,
      summary: event.summary,
      description: event.description,
      location: event.location,
      url: event.url,
      status: event.status,
      transparency: event.transparency,
      dtStart: event.dtStart.toISOString(),
      dtEnd: event.dtEnd?.toISOString() ?? null,
      allDay: event.allDay,
      timeZone: event.timeZone,
      recurrenceRule: event.recurrenceRule,
      source: event.source,
      createdAt: event.createdAt.toISOString(),
      updatedAt: event.updatedAt.toISOString(),
    },
  });
}

/**
 * PATCH /api/calendar/events/:eventId — Update an event
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ eventId: string }> },
) {
  const { eventId } = await params;

  const authResult = await requireCalendarEventOwner(eventId);
  if (!authResult.ok) return authResult.response;
  const event = authResult.event;

  // Fetch calendar with account for CalDAV push
  const calendarWithAccount = await prisma.calendar.findUnique({
    where: { id: event.calendarId },
    include: { account: true },
  });
  if (!calendarWithAccount) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = await request.json();
  const updateData: Record<string, unknown> = {};

  if (body.summary !== undefined) updateData.summary = body.summary;
  if (body.description !== undefined) updateData.description = body.description;
  if (body.location !== undefined) updateData.location = body.location;
  if (body.allDay !== undefined) updateData.allDay = body.allDay;
  if (body.recurrenceRule !== undefined) updateData.recurrenceRule = body.recurrenceRule;
  if (body.status !== undefined) updateData.status = body.status;
  if (body.transparency !== undefined) updateData.transparency = body.transparency;

  try {
    const timeUpdate = resolveEventTimeUpdate(
      {
        dtStart: event.dtStart,
        dtEnd: event.dtEnd,
        timeZone: event.timeZone,
        allDay: event.allDay,
      },
      {
        dtStart: body.dtStart,
        dtEnd: body.dtEnd,
        timeZone: body.timeZone,
        allDay: body.allDay,
      },
    );
    if (timeUpdate.dtStart !== undefined) updateData.dtStart = timeUpdate.dtStart;
    if (timeUpdate.dtEnd !== undefined) updateData.dtEnd = timeUpdate.dtEnd;
    if (timeUpdate.timeZone !== undefined) updateData.timeZone = timeUpdate.timeZone;
  } catch (err) {
    console.error(`Rejected update with invalid times for event ${eventId}:`, err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Invalid event times" },
      { status: 400 },
    );
  }

  const updated = await prisma.calendarEvent.update({
    where: { id: eventId },
    data: updateData,
  });

  // Push to CalDAV if this is a CalDAV calendar
  if (calendarWithAccount.account.accountType === "caldav" && event.source === "caldav") {
    const icsEvent: ICSExportEvent & { url?: string; sequence?: number } = {
      uid: updated.uid,
      summary: updated.summary,
      description: updated.description,
      location: updated.location,
      dtStart: updated.dtStart,
      dtEnd: updated.dtEnd,
      allDay: updated.allDay,
      timeZone: updated.timeZone,
      recurrenceRule: updated.recurrenceRule,
      status: updated.status,
      transparency: updated.transparency,
      ...(updated.url ? { url: updated.url } : {}),
      sequence: updated.sequence,
    };

    const result = await pushUpdateToCalDAV(event.calendarId, icsEvent);
    if (!result.success) {
      console.error(`Failed to push update to CalDAV: ${result.error}`);
      // Don't fail the request — local update succeeded
    }
  }

  return NextResponse.json({
    event: {
      id: updated.id,
      summary: updated.summary,
      dtStart: updated.dtStart.toISOString(),
      dtEnd: updated.dtEnd?.toISOString() ?? null,
      timeZone: updated.timeZone,
      updatedAt: updated.updatedAt.toISOString(),
    },
  });
}

/**
 * DELETE /api/calendar/events/:eventId — Delete an event
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ eventId: string }> },
) {
  const { eventId } = await params;

  const authResult = await requireCalendarEventOwner(eventId);
  if (!authResult.ok) return authResult.response;
  const event = authResult.event;

  // Fetch calendar with account for CalDAV delete
  const calendarWithAccount = await prisma.calendar.findUnique({
    where: { id: event.calendarId },
    include: { account: true },
  });
  if (!calendarWithAccount) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Delete from CalDAV first if this is a CalDAV event
  if (
    calendarWithAccount.account.accountType === "caldav" &&
    event.source === "caldav" &&
    event.url
  ) {
    const result = await pushDeleteToCalDAV(event.calendarId, event.url);
    if (!result.success) {
      console.error(`Failed to push delete to CalDAV: ${result.error}`);
      // Don't fail the request — proceed with local delete
    }
  }

  await prisma.calendarEvent.delete({
    where: { id: eventId },
  });

  return NextResponse.json({ ok: true });
}
