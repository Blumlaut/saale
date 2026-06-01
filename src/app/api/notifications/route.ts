import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { getRedis } from "@/lib/redis";
import { headers } from "next/headers";

const NOTIFICATION_KEY = "notifications:";

/**
 * GET /api/notifications — Get user's notifications
 */
export async function GET() {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const redis = getRedis();
  const key = `${NOTIFICATION_KEY}${session.user.id}`;

  // Get last 50 notifications
  const notifications = await redis.lrange(key, 0, 49);

  return NextResponse.json({
    notifications: notifications.map((n) => JSON.parse(n as string)),
  });
}

/**
 * POST /api/notifications — Send a notification (internal use)
 */
export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const { type, title, message, data } = body;

  const notification = {
    id: crypto.randomUUID(),
    type,
    title,
    message,
    data,
    read: false,
    createdAt: new Date().toISOString(),
  };

  const redis = getRedis();
  const key = `${NOTIFICATION_KEY}${session.user.id}`;

  // Add to list (keep last 100)
  await redis.lpush(key, JSON.stringify(notification));
  await redis.ltrim(key, 0, 99);

  return NextResponse.json({ ok: true, notification });
}

/**
 * PATCH /api/notifications — Mark notifications as read
 */
export async function PATCH(request: NextRequest) {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const { ids, all } = body;

  const redis = getRedis();
  const key = `${NOTIFICATION_KEY}${session.user.id}`;

  const rawNotifications = await redis.lrange(key, 0, -1);
  let notifications: Array<{ id: string; read: boolean }> = rawNotifications.map((n) => JSON.parse(n as string));

  if (all) {
    notifications = notifications.map((n) => ({ ...n, read: true }));
  } else if (ids) {
    notifications = notifications.map((n) =>
      ids.includes(n.id) ? { ...n, read: true } : n,
    );
  }

  await redis.del(key);
  for (const n of notifications) {
    await redis.lpush(key, JSON.stringify(n));
  }

  return NextResponse.json({ ok: true });
}
