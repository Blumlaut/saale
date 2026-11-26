import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/auth";
import {
  addInboxNotification,
  listInboxNotifications,
  markInboxNotifications,
} from "@/lib/notifications/inbox";

/** What a read request names: some entries, or all of them. */
const MARK_READ_BODY = z.object({
  ids: z.array(z.string()).optional(),
  all: z.boolean().optional(),
});

/**
 * GET /api/notifications. The user's in-app notifications, newest first
 */
export async function GET() {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  return NextResponse.json({ notifications: await listInboxNotifications(authResult.user.id) });
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

  const parsed = MARK_READ_BODY.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  await markInboxNotifications(authResult.user.id, {
    ...(parsed.data.all ? { all: true } : { ids: parsed.data.ids ?? [] }),
  });

  return NextResponse.json({ ok: true });
}
