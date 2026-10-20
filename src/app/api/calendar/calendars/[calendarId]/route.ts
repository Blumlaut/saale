import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireCalendarOwner } from "@/lib/auth";
import { prisma } from "@/lib/db";

/**
 * PATCH /api/calendar/calendars/:calendarId. Update a calendar
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ calendarId: string }> },
) {
  const { calendarId } = await params;

  const authResult = await requireCalendarOwner(calendarId);
  if (!authResult.ok) return authResult.response;

  const body = await request.json();
  const updateData: Record<string, unknown> = {};

  if (body.name !== undefined) updateData.name = body.name;
  if (body.enabled !== undefined) updateData.enabled = body.enabled;
  if (body.color !== undefined) updateData.color = body.color;

  const updated = await prisma.calendar.update({
    where: { id: calendarId },
    data: updateData,
  });

  return NextResponse.json({
    calendar: {
      id: updated.id,
      name: updated.name,
      enabled: updated.enabled,
      color: updated.color,
    },
  });
}

/**
 * DELETE /api/calendar/calendars/:calendarId. Delete a calendar
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ calendarId: string }> },
) {
  const { calendarId } = await params;

  const authResult = await requireCalendarOwner(calendarId);
  if (!authResult.ok) return authResult.response;

  await prisma.calendar.delete({
    where: { id: calendarId },
  });

  return NextResponse.json({ ok: true });
}
