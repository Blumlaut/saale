import { NextRequest, NextResponse } from "next/server";
import { requireAccountOwner } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { syncEmailAccount } from "@/lib/email/sync";

/**
 * POST /api/email/accounts/:accountId/sync — Trigger manual sync
 * Query params: full=true to force a full sync (ignore lastSyncedAt)
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ accountId: string }> },
) {
  const { accountId } = await params;

  const authResult = await requireAccountOwner(accountId);
  if (!authResult.ok) return authResult.response;
  const { account } = authResult;

  // Support ?full=true to force a full sync
  const url = new URL(request.url);
  const forceFull = url.searchParams.get("full") === "true";
  if (forceFull && account.lastSyncedAt) {
    await prisma.emailAccount.update({
      where: { id: accountId },
      data: { lastSyncedAt: null },
    });
  }

  try {
    const result = await syncEmailAccount(accountId);
    return NextResponse.json({
      synced: true,
      newMessages: result.newMessages,
      updatedMessages: result.updatedMessages,
      errors: result.errors,
    });
  } catch (err) {
    return NextResponse.json(
      {
        synced: false,
        error: (err as Error).message,
      },
      { status: 500 },
    );
  }
}
