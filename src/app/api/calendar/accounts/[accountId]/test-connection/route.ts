import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { sanitizeError } from "@/lib/auth";
import { connectCalDAV } from "@/lib/calendar/caldav";
import { prisma } from "@/lib/db";
import { encrypt } from "@/lib/crypto";

/**
 * POST /api/calendar/accounts/:accountId/test-connection — Test CalDAV connection
 * For new accounts: accepts credentials in request body
 * For existing accounts: uses stored credentials
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ accountId: string }> },
) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const { accountId } = await params;
  const body = await request.json();

  let testAccountId = accountId;

  // If no accountId, create a temporary account for testing
  if (!accountId || accountId === "new") {
    const { serverUrl, username, password, authMethod } = body;
    if (!serverUrl || !username || !password) {
      return NextResponse.json(
        { error: "Missing required fields: serverUrl, username, password" },
        { status: 400 },
      );
    }

    const encryptedPassword = encrypt(password);
    const tempAccount = await prisma.calendarAccount.create({
      data: {
        userId: authResult.user.id,
        name: "Test Connection",
        serverUrl,
        username,
        encryptedPassword,
        authMethod: authMethod ?? "basic",
        enabled: false,
      },
    });
    testAccountId = tempAccount.id;
  }

  try {
    const { client } = await connectCalDAV(testAccountId);
    const calendars = await client.fetchCalendars();

    // If this was a temp account and connection succeeded, rename and enable it
    if (!accountId || accountId === "new") {
      await prisma.calendarAccount.update({
        where: { id: testAccountId },
        data: {
          name: body.name ?? `CalDAV (${body.username})`,
          enabled: true,
        },
      });
    }

    // Save discovered calendars to the DB
    for (const remoteCal of calendars) {
      await prisma.calendar.upsert({
        where: {
          accountId_remoteId: {
            accountId: testAccountId,
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
          accountId: testAccountId,
          remoteId: (remoteCal.url as string) || "",
          name: (remoteCal.displayName as string) || remoteCal.url || "Unnamed",
          color: remoteCal.calendarColor ?? null,
          description: remoteCal.description ?? null,
          ctag: remoteCal.ctag ?? null,
        },
      });
    }

    return NextResponse.json({
      success: true,
      calendars: calendars.map((c) => ({
        url: c.url,
        displayName: c.displayName,
        calendarColor: c.calendarColor,
      })),
    });
  } catch (err) {
    // Clean up temp account on failure
    if (!accountId || accountId === "new") {
      await prisma.calendarAccount.delete({ where: { id: testAccountId } }).catch((err) => {
        console.error("Failed to clean up temp calendar account:", err);
      });
    }

    return NextResponse.json({ success: false, error: sanitizeError(err) }, { status: 502 });
  }
}
