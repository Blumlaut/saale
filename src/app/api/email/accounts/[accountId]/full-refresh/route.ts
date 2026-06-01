import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { headers } from "next/headers";
import { syncEmailAccount } from "@/lib/email/sync";

/**
 * POST /api/email/accounts/:accountId/full-refresh — Delete all synced messages and resync from scratch
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ accountId: string }> },
) {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { accountId } = await params;

  const account = await prisma.emailAccount.findFirst({
    where: { id: accountId, userId: session.user.id },
  });

  if (!account) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

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
        error: (err as Error).message,
      },
      { status: 500 },
    );
  }
}
