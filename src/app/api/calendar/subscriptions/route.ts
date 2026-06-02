import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { encrypt } from "@/lib/crypto";
import { syncSubscription } from "@/lib/calendar/subscription-sync";

/**
 * GET /api/calendar/subscriptions — List user's ICS subscriptions
 */
export async function GET() {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const subscriptions = await prisma.calendarSubscription.findMany({
    where: { userId: authResult.user.id },
    include: {
      calendar: {
        select: {
          id: true,
          name: true,
          color: true,
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  return NextResponse.json({
    subscriptions: subscriptions.map((s) => ({
      id: s.id,
      name: s.name,
      url: s.url,
      calendarId: s.calendarId,
      calendarName: s.calendar.name,
      calendarColor: s.calendar.color,
      enabled: s.enabled,
      lastSyncedAt: s.lastSyncedAt?.toISOString() ?? null,
      createdAt: s.createdAt.toISOString(),
    })),
  });
}

/**
 * POST /api/calendar/subscriptions — Create a new ICS subscription
 */
export async function POST(request: NextRequest) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const body = await request.json();
  const { name, url, calendarId, username, password } = body;

  if (!name || !url || !calendarId) {
    return NextResponse.json(
      { error: "Missing required fields: name, url, calendarId" },
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

  // Ensure target calendar is on a local account
  const account = await prisma.calendarAccount.findUnique({
    where: { id: calendar.accountId },
  });
  if (account?.accountType !== "local") {
    return NextResponse.json(
      { error: "Subscriptions can only target local calendars" },
      { status: 400 },
    );
  }

  const subscription = await prisma.calendarSubscription.create({
    data: {
      userId: authResult.user.id,
      calendarId,
      name,
      url,
      username: username ?? null,
      password: password ? encrypt(password) : null,
    },
  });

  // Trigger initial sync in background
  syncSubscription(subscription.id).catch(() => {});

  return NextResponse.json({
    subscription: {
      id: subscription.id,
      name: subscription.name,
      url: subscription.url,
      enabled: subscription.enabled,
    },
  });
}

/**
 * DELETE /api/calendar/subscriptions — Bulk delete (not used, individual delete is via [id])
 */
export async function DELETE() {
  return NextResponse.json({ error: "Method not allowed" }, { status: 405 });
}
