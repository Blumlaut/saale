import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { encrypt } from "@/lib/crypto";
import { syncSubscription } from "@/lib/calendar/subscription-sync";

/**
 * PATCH /api/calendar/subscriptions/:id — Update a subscription
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ subscriptionId: string }> },
) {
  const { subscriptionId } = await params;

  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const subscription = await prisma.calendarSubscription.findFirst({
    where: { id: subscriptionId, userId: authResult.user.id },
  });
  if (!subscription) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = await request.json();
  const updateData: Record<string, unknown> = {};

  if (body.name !== undefined) updateData.name = body.name;
  if (body.url !== undefined) updateData.url = body.url;
  if (body.enabled !== undefined) updateData.enabled = body.enabled;
  if (body.username !== undefined) updateData.username = body.username;
  if (body.password) {
    updateData.password = encrypt(body.password);
  }

  const updated = await prisma.calendarSubscription.update({
    where: { id: subscriptionId },
    data: updateData,
  });

  return NextResponse.json({
    subscription: {
      id: updated.id,
      name: updated.name,
      url: updated.url,
      enabled: updated.enabled,
      updatedAt: updated.updatedAt.toISOString(),
    },
  });
}

/**
 * POST /api/calendar/subscriptions/:id/sync — Trigger immediate sync
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ subscriptionId: string }> },
) {
  const { subscriptionId } = await params;

  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const subscription = await prisma.calendarSubscription.findFirst({
    where: { id: subscriptionId, userId: authResult.user.id },
  });
  if (!subscription) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const result = await syncSubscription(subscriptionId, authResult.user.id);

  return NextResponse.json({
    sync: {
      eventsCreated: result.eventsCreated,
      eventsUpdated: result.eventsUpdated,
      eventsDeleted: result.eventsDeleted,
      error: result.error,
      parsedEvents: result.parsedEvents ?? null,
    },
  });
}

/**
 * DELETE /api/calendar/subscriptions/:id — Delete a subscription
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ subscriptionId: string }> },
) {
  const { subscriptionId } = await params;

  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const subscription = await prisma.calendarSubscription.findFirst({
    where: { id: subscriptionId, userId: authResult.user.id },
  });
  if (!subscription) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  await prisma.calendarSubscription.delete({
    where: { id: subscriptionId },
  });

  // Also delete events from this subscription
  await prisma.calendarEvent.deleteMany({
    where: {
      calendarId: subscription.calendarId,
      source: "subscription",
    },
  });

  return NextResponse.json({ ok: true });
}
