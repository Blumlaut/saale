import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { headers } from "next/headers";
import { syncEmailAccount } from "@/lib/email/sync";

/**
 * POST /api/email/accounts/:accountId/sync — Trigger manual sync
 * Query params: full=true to force a full sync (ignore lastSyncedAt)
 */
export async function POST(
  request: NextRequest,
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
