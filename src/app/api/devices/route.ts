import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { getDesktopDownloads } from "@/lib/devices/download";
import { listDevices } from "@/lib/devices/store";

/**
 * GET /api/devices. the user's paired computers, and the agent builds they can
 * install for this instance's version.
 */
export async function GET() {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const devices = await listDevices(authResult.user.id);

  return NextResponse.json({ devices, downloads: getDesktopDownloads() });
}
