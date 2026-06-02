import { NextRequest, NextResponse } from "next/server";
import { requireCalendarAccountOwner } from "@/lib/auth";
import { sanitizeError } from "@/lib/auth";
import { discoverCalendars } from "@/lib/calendar/caldav";
import { prisma } from "@/lib/db";

/**
 * POST /api/calendar/accounts/:accountId/discover — Discover remote calendars
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ accountId: string }> },
) {
  const { accountId } = await params;

  const authResult = await requireCalendarAccountOwner(accountId);
  if (!authResult.ok) return authResult.response;

  try {
    const remoteCalendars = await discoverCalendars(accountId);

    // Upsert discovered calendars
    const calendars = await Promise.all(
      remoteCalendars.map((remoteCal) =>
        prisma.calendar.upsert({
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
        }),
      ),
    );

    return NextResponse.json({
      calendars: calendars.map((c) => ({
        id: c.id,
        remoteId: c.remoteId,
        name: c.name,
        color: c.color,
        enabled: c.enabled,
      })),
    });
  } catch (err) {
    return NextResponse.json({ error: sanitizeError(err) }, { status: 502 });
  }
}
