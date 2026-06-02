import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { parseICS } from "@/lib/calendar/ics-import";

/**
 * GET /api/calendar/events — Fetch events with optional date range and calendar filters
 * Query params: from, to, calendarIds (comma-separated)
 */
export async function GET(request: NextRequest) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const { searchParams } = new URL(request.url);
  const from = searchParams.get("from");
  const to = searchParams.get("to");
  const calendarIds = searchParams.get("calendarIds");

  // Build where clause — scope to user's calendars
  const where: Record<string, unknown> = {
    calendar: {
      account: { userId: authResult.user.id },
      enabled: true,
    },
  };

  const dtStartFilter: Record<string, unknown> = {};
  if (from) dtStartFilter.gte = new Date(from);
  if (to) dtStartFilter.lte = new Date(to);
  if (Object.keys(dtStartFilter).length > 0) {
    where.dtStart = dtStartFilter;
  }

  if (calendarIds) {
    const ids = calendarIds
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);
    where.calendarId = { in: ids };
  }

  const events = await prisma.calendarEvent.findMany({
    where,
    orderBy: { dtStart: "asc" },
    include: {
      calendar: {
        select: {
          id: true,
          name: true,
          color: true,
        },
      },
    },
    take: 500,
  });

  return NextResponse.json({
    events: events.map((e) => ({
      id: e.id,
      uid: e.uid,
      calendarId: e.calendarId,
      calendarName: e.calendar.name,
      calendarColor: e.calendar.color,
      summary: e.summary,
      description: e.description,
      location: e.location,
      url: e.url,
      status: e.status,
      transparency: e.transparency,
      dtStart: e.dtStart.toISOString(),
      dtEnd: e.dtEnd?.toISOString() ?? null,
      allDay: e.allDay,
      timeZone: e.timeZone,
      recurrenceRule: e.recurrenceRule,
      source: e.source,
      createdAt: e.createdAt.toISOString(),
      updatedAt: e.updatedAt.toISOString(),
    })),
  });
}

/**
 * POST /api/calendar/events — Create a new event
 */
export async function POST(request: NextRequest) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const body = await request.json();
  const {
    calendarId,
    summary,
    description,
    location,
    dtStart,
    dtEnd,
    allDay,
    timeZone,
    recurrenceRule,
    status,
    transparency,
  } = body;

  if (!calendarId || !dtStart) {
    return NextResponse.json(
      { error: "Missing required fields: calendarId, dtStart" },
      { status: 400 },
    );
  }

  // Verify calendar belongs to user
  const calendar = await prisma.calendar.findFirst({
    where: {
      id: calendarId,
      account: { userId: authResult.user.id },
    },
  });
  if (!calendar) {
    return NextResponse.json({ error: "Calendar not found" }, { status: 404 });
  }

  const uid = `manual-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@saale`;

  const event = await prisma.calendarEvent.create({
    data: {
      calendarId,
      uid,
      summary: summary ?? "(no title)",
      description: description ?? null,
      location: location ?? null,
      dtStart: new Date(dtStart),
      dtEnd: dtEnd ? new Date(dtEnd) : null,
      allDay: allDay ?? false,
      timeZone: timeZone ?? null,
      recurrenceRule: recurrenceRule ?? null,
      status: status ?? null,
      transparency: transparency ?? null,
      source: "manual",
    },
  });

  return NextResponse.json({
    event: {
      id: event.id,
      uid: event.uid,
      summary: event.summary,
      dtStart: event.dtStart.toISOString(),
      dtEnd: event.dtEnd?.toISOString() ?? null,
      allDay: event.allDay,
      source: event.source,
    },
  });
}

/**
 * PUT /api/calendar/events/import — Import .ics file
 */
export async function PUT(request: NextRequest) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const formData = await request.formData();
  const file = formData.get("file") as File | null;
  const calendarId = formData.get("calendarId") as string | null;

  if (!file) {
    return NextResponse.json({ error: "No file provided" }, { status: 400 });
  }

  // Find target calendar
  let targetCalendarId = calendarId;
  if (!targetCalendarId) {
    const defaultCalendar = await prisma.calendar.findFirst({
      where: { account: { userId: authResult.user.id }, enabled: true },
      orderBy: { createdAt: "asc" },
    });
    if (!defaultCalendar) {
      return NextResponse.json({ error: "No calendar found. Create one first." }, { status: 400 });
    }
    targetCalendarId = defaultCalendar.id;
  }

  // Verify calendar belongs to user
  const calendar = await prisma.calendar.findFirst({
    where: {
      id: targetCalendarId,
      account: { userId: authResult.user.id },
    },
  });
  if (!calendar) {
    return NextResponse.json({ error: "Calendar not found" }, { status: 404 });
  }

  const icsContent = await file.text();
  const parsedEvents = parseICS(icsContent);

  let created = 0;
  const skipped: string[] = [];

  for (const evt of parsedEvents) {
    const existing = await prisma.calendarEvent.findUnique({
      where: {
        calendarId_uid: {
          calendarId: targetCalendarId,
          uid: evt.uid,
        },
      },
    });

    if (existing) {
      skipped.push(evt.uid);
      continue;
    }

    await prisma.calendarEvent.create({
      data: {
        calendarId: targetCalendarId,
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
        source: "ics_import",
      },
    });
    created++;
  }

  return NextResponse.json({
    imported: created,
    skipped: skipped.length,
    skippedUids: skipped,
  });
}
