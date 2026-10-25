import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { getRedis } from "@/lib/redis";
import { addInboxNotification } from "@/lib/notifications/inbox";

const NOTIFICATION_KEY = "notifications:";

/**
 * GET /api/notifications. Get user's notifications
 */
export async function GET() {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const redis = getRedis();
  const key = `${NOTIFICATION_KEY}${authResult.user.id}`;

  // Get last 50 notifications
  const notifications = await redis.lrange(key, 0, 49);

  return NextResponse.json({
    notifications: notifications.map((n) => JSON.parse(n as string)),
  });
}

/**
 * POST /api/notifications. Send a notification (internal use)
 */
export async function POST(request: NextRequest) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const body = await request.json();
  const { type, title, message, data } = body;

  const notification = await addInboxNotification(authResult.user.id, {
    type,
    title,
    message,
    data,
  });

  return NextResponse.json({ ok: true, notification });
}

/**
 * PATCH /api/notifications. Mark notifications as read
 */
export async function PATCH(request: NextRequest) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const body = await request.json();
  const { ids, all } = body;

  const redis = getRedis();
  const key = `${NOTIFICATION_KEY}${authResult.user.id}`;

  const rawNotifications = await redis.lrange(key, 0, -1);
  let notifications: Array<{ id: string; read: boolean }> = rawNotifications.map((n) =>
    JSON.parse(n as string),
  );

  if (all) {
    notifications = notifications.map((n) => ({ ...n, read: true }));
  } else if (ids) {
    notifications = notifications.map((n) => (ids.includes(n.id) ? { ...n, read: true } : n));
  }

  await redis.del(key);
  for (const n of notifications) {
    await redis.lpush(key, JSON.stringify(n));
  }

  return NextResponse.json({ ok: true });
}
