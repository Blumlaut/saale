import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireCalendarAccountOwner } from "@/lib/auth";
import { syncCalendarAccount } from "@/lib/calendar/sync";
import { prisma } from "@/lib/db";

/**
 * POST /api/calendar/accounts/:accountId/sync. Trigger immediate sync
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ accountId: string }> },
) {
  const { accountId } = await params;

  const authResult = await requireCalendarAccountOwner(accountId);
  if (!authResult.ok) return authResult.response;

  // Local accounts don't have remote sync
  const account = await prisma.calendarAccount.findUnique({
    where: { id: accountId },
    select: { accountType: true },
  });
  if (account?.accountType === "local") {
    return NextResponse.json({
      sync: {
        calendarsSynced: 0,
        eventsCreated: 0,
        eventsUpdated: 0,
        eventsDeleted: 0,
        errors: [],
      },
    });
  }

  const result = await syncCalendarAccount(accountId);

  return NextResponse.json({
    sync: {
      calendarsSynced: result.calendarsSynced,
      eventsCreated: result.eventsCreated,
      eventsUpdated: result.eventsUpdated,
      eventsDeleted: result.eventsDeleted,
      errors: result.errors,
    },
  });
}
