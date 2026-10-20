import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { prisma } from "@/lib/db";

/**
 * GET /api/calendar/calendars. List all calendars for the user
 */
export async function GET() {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const calendars = await prisma.calendar.findMany({
    where: {
      account: { userId: authResult.user.id },
    },
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      color: true,
      enabled: true,
      lastSyncedAt: true,
      _count: { select: { events: true } },
      account: {
        select: {
          id: true,
          name: true,
          accountType: true,
        },
      },
    },
  });

  return NextResponse.json({
    calendars: calendars.map((c) => ({
      id: c.id,
      name: c.name,
      color: c.color,
      enabled: c.enabled,
      eventCount: c._count.events,
      lastSyncedAt: c.lastSyncedAt?.toISOString() ?? null,
      account: c.account,
    })),
  });
}

/**
 * POST /api/calendar/calendars. Create a new local calendar
 */
export async function POST(request: NextRequest) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const body = await request.json();
  const { name, color, accountId } = body;

  if (!name) {
    return NextResponse.json({ error: "Name is required" }, { status: 400 });
  }

  // Find or create local account
  let localAccount = await prisma.calendarAccount.findFirst({
    where: {
      userId: authResult.user.id,
      accountType: "local",
    },
  });

  if (!localAccount) {
    localAccount = await prisma.calendarAccount.create({
      data: {
        userId: authResult.user.id,
        accountType: "local",
        name: "Local",
      },
    });
  }

  const targetAccountId = accountId ?? localAccount.id;

  // Verify the target account belongs to the user and is local
  const targetAccount = await prisma.calendarAccount.findFirst({
    where: {
      id: targetAccountId,
      userId: authResult.user.id,
      accountType: "local",
    },
  });

  if (!targetAccount) {
    return NextResponse.json(
      { error: "Invalid account. only local accounts are supported" },
      { status: 400 },
    );
  }

  const calendar = await prisma.calendar.create({
    data: {
      accountId: targetAccountId,
      name,
      color: color ?? "#3b82f6",
    },
  });

  return NextResponse.json({
    calendar: {
      id: calendar.id,
      name: calendar.name,
      color: calendar.color,
      enabled: calendar.enabled,
    },
  });
}
