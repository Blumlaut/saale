import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { prisma } from "@/lib/db";

/**
 * GET /api/calendar/ensure-local-account — Ensure the user has a local calendar account.
 * Creates one if it doesn't exist, returns its details.
 */
export async function GET() {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  // Find or create local account
  let localAccount = await prisma.calendarAccount.findFirst({
    where: {
      userId: authResult.user.id,
      accountType: "local",
    },
    include: {
      calendars: {
        select: {
          id: true,
          name: true,
          color: true,
          enabled: true,
          _count: { select: { events: true } },
        },
        orderBy: { name: "asc" },
      },
    },
  });

  if (!localAccount) {
    const created = await prisma.calendarAccount.create({
      data: {
        userId: authResult.user.id,
        accountType: "local",
        name: "Local",
        calendars: {
          create: {
            name: "My Calendar",
            color: "#3b82f6",
          },
        },
      },
      include: {
        calendars: {
          select: {
            id: true,
            name: true,
            color: true,
            enabled: true,
            _count: { select: { events: true } },
          },
          orderBy: { name: "asc" },
        },
      },
    });
    localAccount = created;
  }

  return NextResponse.json({
    account: {
      id: localAccount.id,
      name: localAccount.name,
      accountType: localAccount.accountType,
      enabled: localAccount.enabled,
      calendars: localAccount.calendars?.map((c) => ({
        id: c.id,
        name: c.name,
        color: c.color,
        enabled: c.enabled,
        eventCount: c._count.events,
      })),
    },
  });
}
