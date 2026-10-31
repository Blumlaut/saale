import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { revokeDevice } from "@/lib/devices/store";
import { evictUserSessions } from "@/lib/pi/agent-pool";

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
