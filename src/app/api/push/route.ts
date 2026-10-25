import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { getVapidPublicKey, isPushConfigured } from "@/lib/push/config";
import { listPushSubscriptions } from "@/lib/push/subscriptions";

/**
 * GET /api/push. What this browser needs to subscribe.
 *
 * `enabled` is false when the instance has no VAPID keys: the browser cannot
 * subscribe at all then, so the settings UI says so instead of requesting
 * permission for something that would never deliver.
 */
export async function GET() {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const devices = await listPushSubscriptions(authResult.user.id);

  return NextResponse.json({
    enabled: isPushConfigured(),
    publicKey: getVapidPublicKey(),
    devices: devices.map((device) => ({
      id: device.id,
      userAgent: device.userAgent,
      createdAt: device.createdAt,
    })),
  });
}
