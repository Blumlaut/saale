import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { prisma } from "@/lib/db";

/**
 * PATCH /api/calendar/calendars/:calendarId — Update a calendar
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ calendarId: string }> },
) {
  const { calendarId } = await params;

  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const calendar = await prisma.calendar.findFirst({
    where: {
      id: calendarId,
      account: { userId: authResult.user.id },
    },
  });
  if (!calendar) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

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
 * DELETE /api/calendar/calendars/:calendarId — Delete a calendar
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ calendarId: string }> },
) {
  const { calendarId } = await params;

  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const calendar = await prisma.calendar.findFirst({
    where: {
      id: calendarId,
      account: { userId: authResult.user.id },
    },
  });
  if (!calendar) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  await prisma.calendar.delete({
    where: { id: calendarId },
  });

  return NextResponse.json({ ok: true });
}
