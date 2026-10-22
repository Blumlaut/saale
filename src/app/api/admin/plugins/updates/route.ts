import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { checkPluginUpdates } from "@/lib/pi/plugins";

/**
 * POST /api/admin/plugins/updates — fetch each git-backed plugin and report
 * how far behind its upstream it is.
 *
 * The only place plugins touch the network, and only when an admin asks.
 */
export async function POST() {
  const authResult = await requirePermission("admin", "plugins");
  if (!authResult.ok) return authResult.response;

  try {
    return NextResponse.json({ updates: await checkPluginUpdates() });
  } catch (err) {
    console.error("Failed to check plugin updates:", err);
    return NextResponse.json({ error: "Failed to check for updates" }, { status: 500 });
  }
}
