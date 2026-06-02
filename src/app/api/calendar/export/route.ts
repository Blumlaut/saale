import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { generateICSBulk } from "@/lib/calendar/ics-export";

/**
 * GET /api/calendar/export — Export events as .ics file
 * Query params: from, to, calendarIds (comma-separated)
 */
export async function GET(request: NextRequest) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const { searchParams } = new URL(request.url);
  const from = searchParams.get("from");
  const to = searchParams.get("to");
  const calendarIds = searchParams.get("calendarIds");

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
    take: 500,
  });

  const icsContent = generateICSBulk(
    events.map((e) => ({
      uid: e.uid,
      summary: e.summary,
      description: e.description ?? null,
      location: e.location ?? null,
      dtStart: e.dtStart,
      dtEnd: e.dtEnd ?? null,
      allDay: e.allDay,
      timeZone: e.timeZone ?? null,
      recurrenceRule: e.recurrenceRule ?? null,
      status: e.status ?? null,
      transparency: e.transparency ?? null,
    })),
  );

  return new NextResponse(icsContent, {
    headers: {
      "Content-Type": "text/calendar",
      "Content-Disposition": 'attachment; filename="calendar-export.ics"',
    },
  });
}
