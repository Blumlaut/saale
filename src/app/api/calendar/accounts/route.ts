import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { encrypt } from "@/lib/crypto";
import { CALENDAR_ACCOUNT_SELECT, serializeCalendarAccount } from "@/lib/calendar/account-summary";
import { discoverCalendars } from "@/lib/calendar/caldav";
import { syncCalendarAccount } from "@/lib/calendar/sync";

/**
 * GET /api/calendar/accounts. List user's CalDAV accounts with their calendars
 */
export async function GET() {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const accounts = await prisma.calendarAccount.findMany({
    where: { userId: authResult.user.id },
    orderBy: { createdAt: "asc" },
    select: CALENDAR_ACCOUNT_SELECT,
  });

  return NextResponse.json({
    accounts: accounts.map(serializeCalendarAccount),
  });
}

/**
 * POST /api/calendar/accounts. Create a new CalDAV account
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
      enabled: true,
    },
  });

  // Trigger discovery + initial sync in background
  (async () => {
    try {
      const remoteCalendars = await discoverCalendars(account.id);

      // Save discovered calendars
      for (const remoteCal of remoteCalendars) {
        await prisma.calendar.upsert({
          where: {
            accountId_remoteId: {
              accountId: account.id,
              remoteId: (remoteCal.url as string) || "",
            },
          },
          update: {
            name: (remoteCal.displayName as string) || remoteCal.url || "Unnamed",
            color: remoteCal.calendarColor ?? null,
            description: remoteCal.description ?? null,
            ctag: remoteCal.ctag ?? null,
          },
          create: {
            accountId: account.id,
            remoteId: (remoteCal.url as string) || "",
            name: (remoteCal.displayName as string) || remoteCal.url || "Unnamed",
            color: remoteCal.calendarColor ?? null,
            description: remoteCal.description ?? null,
            ctag: remoteCal.ctag ?? null,
          },
        });
      }

      // Initial sync
      await syncCalendarAccount(account.id);
    } catch {
      // Discovery or sync failed. account still exists, user can retry manually
    }
  })();

  return NextResponse.json({
    account: {
      id: account.id,
      name: account.name,
      enabled: account.enabled,
      createdAt: account.createdAt.toISOString(),
    },
  });
}
