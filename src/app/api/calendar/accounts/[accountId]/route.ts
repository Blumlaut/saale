import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireCalendarAccountOwner } from "@/lib/auth";
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

  if (!account) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({
    account: {
      id: account.id,
      name: account.name,
      serverUrl: account.serverUrl,
      username: account.username,
      authMethod: account.authMethod,
      enabled: account.enabled,
      lastSyncedAt: account.lastSyncedAt?.toISOString() ?? null,
      createdAt: account.createdAt.toISOString(),
      updatedAt: account.updatedAt.toISOString(),
      calendars: account.calendars.map((c) => ({
        id: c.id,
        remoteId: c.remoteId,
        name: c.name,
        color: c.color,
        enabled: c.enabled,
        lastSyncedAt: c.lastSyncedAt?.toISOString() ?? null,
        eventCount: c._count.events,
      })),
    },
  });
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
