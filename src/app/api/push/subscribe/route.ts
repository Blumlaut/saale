import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/auth";
import { isPushConfigured } from "@/lib/push/config";
import { deletePushSubscription, savePushSubscription } from "@/lib/push/subscriptions";

/**
 * A browser's `PushSubscription.toJSON()`. The keys are base64url, so they are
 * only checked for presence here — the push service is what rejects a bad key.
 */
const subscribeBodySchema = z.object({
  endpoint: z.url().max(2048),
  keys: z.object({
    p256dh: z.string().min(1).max(255),
    auth: z.string().min(1).max(255),
  }),
});

const unsubscribeBodySchema = z.object({
  endpoint: z.url().max(2048),
});

/** Longest user agent kept as a device label. */
const MAX_USER_AGENT_LENGTH = 300;

/**
 * POST /api/push. Subscribe this browser.
 *
 * The row belongs to the signed-in user, so the same browser signing in as
 * another account moves the subscription to that account instead of leaving a
 * device that receives the previous user's notifications.
 */
export async function POST(request: NextRequest) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  if (!isPushConfigured()) {
    return NextResponse.json(
      { error: "Push notifications are not configured on this instance" },
      { status: 503 },
    );
  }

  const parsed = subscribeBodySchema.safeParse(await request.json().catch(() => undefined));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid push subscription" }, { status: 400 });
  }

  const userAgent = request.headers.get("user-agent")?.slice(0, MAX_USER_AGENT_LENGTH) ?? null;

  try {
    await savePushSubscription(authResult.user.id, {
      endpoint: parsed.data.endpoint,
      p256dh: parsed.data.keys.p256dh,
      auth: parsed.data.keys.auth,
      userAgent,
    });
  } catch (err) {
    console.error(`Failed to save push subscription for user ${authResult.user.id}:`, err);
    return NextResponse.json({ error: "Failed to save push subscription" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}

/**
 * DELETE /api/push. Unsubscribe this browser.
 */
export async function DELETE(request: NextRequest) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const parsed = unsubscribeBodySchema.safeParse(await request.json().catch(() => undefined));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid push subscription" }, { status: 400 });
  }

  try {
    await deletePushSubscription(authResult.user.id, parsed.data.endpoint);
  } catch (err) {
    console.error(`Failed to remove push subscription for user ${authResult.user.id}:`, err);
    return NextResponse.json({ error: "Failed to remove push subscription" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
