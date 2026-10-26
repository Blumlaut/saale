import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireCalendarAccountOwner } from "@/lib/auth";
import { CALENDAR_ACCOUNT_SELECT, serializeCalendarAccount } from "@/lib/calendar/account-summary";
import { prisma } from "@/lib/db";
import { encrypt } from "@/lib/crypto";

/**
 * GET /api/calendar/accounts/:accountId. Get account details
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ accountId: string }> },
) {
  const { accountId } = await params;

  const authResult = await requireCalendarAccountOwner(accountId);
  if (!authResult.ok) return authResult.response;

  const account = await prisma.calendarAccount.findUnique({
    where: { id: accountId },
    select: CALENDAR_ACCOUNT_SELECT,
  });

  if (!account) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({ account: serializeCalendarAccount(account) });
}

/**
 * PATCH /api/calendar/accounts/:accountId. Update a calendar account
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ accountId: string }> },
) {
  const { accountId } = await params;

  const authResult = await requireCalendarAccountOwner(accountId);
  if (!authResult.ok) return authResult.response;

  const body = await request.json();
  const updateData: Record<string, unknown> = {};

  if (body.name !== undefined) updateData.name = body.name;
  if (body.enabled !== undefined) updateData.enabled = body.enabled;
  if (body.password) {
    updateData.encryptedPassword = encrypt(body.password);
  }

  const updated = await prisma.calendarAccount.update({
    where: { id: accountId },
    data: updateData,
  });

  return NextResponse.json({
    account: {
      id: updated.id,
      name: updated.name,
      enabled: updated.enabled,
      updatedAt: updated.updatedAt.toISOString(),
    },
  });
}

/**
 * DELETE /api/calendar/accounts/:accountId. Delete a calendar account
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ accountId: string }> },
) {
  const { accountId } = await params;

  const authResult = await requireCalendarAccountOwner(accountId);
  if (!authResult.ok) return authResult.response;

  await prisma.calendarAccount.delete({
    where: { id: accountId },
  });

  return NextResponse.json({ ok: true });
}
