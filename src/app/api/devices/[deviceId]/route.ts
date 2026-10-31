import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { groupsNotification, publishToDevice } from "@/lib/devices/channel";
import { readDeviceGroups } from "@/lib/devices/shared";
import { getChatDevice, revokeDevice } from "@/lib/devices/store";
import { evictUserSessions } from "@/lib/pi/agent-pool";

/**
 * PATCH /api/devices/:deviceId. change which tool groups a computer offers.
 *
 * The agent owns the switches; this asks it to change them over its own channel.
 * It applies the set, keeps it for the next run, and answers with a hello the
 * channel records, so the page shows what the machine actually offers rather
 * than what was requested.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ deviceId: string }> },
) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const { deviceId } = await params;
  const device = await getChatDevice(authResult.user.id, deviceId);
  if (!device) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || !Array.isArray(body.groups)) {
    return NextResponse.json({ error: "A list of groups is required" }, { status: 400 });
  }

  const groups = readDeviceGroups(body.groups);

  try {
    await publishToDevice(device.id, groupsNotification(groups));
  } catch (err) {
    console.error(`Failed to reach device ${device.id}:`, err);
    return NextResponse.json({ error: "That computer is not connected" }, { status: 503 });
  }

  // A pooled chat built its tool list from the old set.
  await evictUserSessions(authResult.user.id);

  return NextResponse.json({ groups });
}

/**
 * DELETE /api/devices/:deviceId. disconnect a computer.
 *
 * The row stays, so the settings page can show it was there; its token stops
 * working. Pooled sessions are evicted because their tool list was built while
 * the device was still reachable.
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ deviceId: string }> },
) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const { deviceId } = await params;
  const revoked = await revokeDevice(authResult.user.id, deviceId);
  if (!revoked) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await evictUserSessions(authResult.user.id);

  return NextResponse.json({ ok: true });
}
