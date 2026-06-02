import { NextRequest, NextResponse } from "next/server";
import { requireAccountOwner, sanitizeError } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { syncEmailAccount } from "@/lib/email/sync";

/**
 * POST /api/email/accounts/:accountId/full-refresh — Delete all synced messages and resync from scratch
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ accountId: string }> },
) {
  const { accountId } = await params;

  const authResult = await requireAccountOwner(accountId);
  if (!authResult.ok) return authResult.response;

  // Delete all messages and reset sync timestamp
  await prisma.emailMessage.deleteMany({ where: { accountId } });
  await prisma.emailAccount.update({
    where: { id: accountId },
    data: { lastSyncedAt: null },
  });

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
        error: sanitizeError(err),
      },
      { status: 500 },
    );
  }
}
