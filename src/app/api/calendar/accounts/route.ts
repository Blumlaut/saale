import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { encrypt } from "@/lib/crypto";

/**
 * GET /api/calendar/accounts — List user's CalDAV accounts with their calendars
 */
export async function GET() {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const accounts = await prisma.calendarAccount.findMany({
    where: { userId: authResult.user.id },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      name: true,
      serverUrl: true,
      username: true,
      authMethod: true,
      enabled: true,
      lastSyncedAt: true,
      createdAt: true,
      updatedAt: true,
      calendars: {
        select: {
          id: true,
          remoteId: true,
          name: true,
          color: true,
          enabled: true,
          lastSyncedAt: true,
          _count: { select: { events: true } },
        },
        orderBy: { name: "asc" },
      },
    },
  });

  return NextResponse.json({
    accounts: accounts.map((a) => ({
      id: a.id,
      name: a.name,
      serverUrl: a.serverUrl,
      username: a.username,
      authMethod: a.authMethod,
      enabled: a.enabled,
      lastSyncedAt: a.lastSyncedAt?.toISOString() ?? null,
      createdAt: a.createdAt.toISOString(),
      updatedAt: a.updatedAt.toISOString(),
      calendars: a.calendars.map((c) => ({
        id: c.id,
        remoteId: c.remoteId,
        name: c.name,
        color: c.color,
        enabled: c.enabled,
        lastSyncedAt: c.lastSyncedAt?.toISOString() ?? null,
        eventCount: c._count.events,
      })),
    })),
  });
}

/**
 * POST /api/calendar/accounts — Create a new CalDAV account
 */
export async function POST(request: NextRequest) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const body = await request.json();
  const { name, serverUrl, username, password, authMethod } = body;

  if (!name || !serverUrl || !username || !password) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  const encryptedPassword = encrypt(password);

  const account = await prisma.calendarAccount.create({
    data: {
      userId: authResult.user.id,
      name,
      serverUrl,
      username,
      encryptedPassword,
      authMethod: authMethod ?? "basic",
    },
  });

  return NextResponse.json({
    account: {
      id: account.id,
      name: account.name,
      enabled: account.enabled,
      createdAt: account.createdAt.toISOString(),
    },
  });
}
