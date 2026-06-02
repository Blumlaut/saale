import { NextRequest, NextResponse } from "next/server";
import { requireCalendarAccountOwner } from "@/lib/auth";
import { syncCalendarAccount } from "@/lib/calendar/sync";

/**
 * POST /api/calendar/accounts/:accountId/sync — Trigger immediate sync
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ accountId: string }> },
) {
  const { accountId } = await params;

  const authResult = await requireCalendarAccountOwner(accountId);
  if (!authResult.ok) return authResult.response;

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
