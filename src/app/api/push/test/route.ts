import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { isPushConfigured } from "@/lib/push/config";
import { sendPushToUser } from "@/lib/push/send";
import { isRateLimited } from "@/lib/redis";

/**
 * POST /api/push/test. Send a test notification to this user's devices.
 *
 * Bypasses the per-category switches: it is the check that the whole path
 * (permission, subscription, keys, service worker) works, so it has to arrive
 * whatever the user turned off.
 */
export async function POST() {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  if (!isPushConfigured()) {
    return NextResponse.json(
      { error: "Push notifications are not configured on this instance" },
      { status: 503 },
    );
  }

  if (await isRateLimited(`push-test:${authResult.user.id}`)) {
    return NextResponse.json({ error: "Too many test notifications" }, { status: 429 });
  }

  try {
    const delivery = await sendPushToUser(authResult.user.id, {
      title: "Saale",
      body: "Notifications are working. This is a test.",
      url: "/dashboard/settings/notifications",
      tag: "saale-test",
    });

    if (delivery.sent === 0) {
      return NextResponse.json(
        { error: "No subscribed device could be reached", delivery },
        { status: 502 },
      );
    }

    return NextResponse.json({ ok: true, delivery });
  } catch (err) {
    console.error(`Failed to send test push for user ${authResult.user.id}:`, err);
    return NextResponse.json({ error: "Failed to send test notification" }, { status: 500 });
  }
}
