import { NextResponse } from "next/server";

import { requirePermission } from "@/lib/auth";
import { getLatestRelease, isUpdateAvailable } from "@/lib/updates/release";
import { APP_VERSION } from "@/lib/version";

/**
 * GET /api/updates — the release this build came from, and the newest one.
 *
 * Admins only: the console footer shows the answer to them, and the one who
 * acts on it is the one who can reach the deployment.
 */
export async function GET() {
  const authResult = await requirePermission("admin", "access");
  if (!authResult.ok) return authResult.response;

  const latest = await getLatestRelease();

  return NextResponse.json({
    current: APP_VERSION,
    latest,
    updateAvailable: isUpdateAvailable(latest),
  });
}
