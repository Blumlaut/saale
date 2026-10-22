import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { evictAllSessions } from "@/lib/pi/agent-pool";
import { invalidatePluginCache } from "@/lib/pi/plugins";

/**
 * POST /api/admin/plugins/reload — rebuild every pooled session.
 *
 * The plugin set is fixed when a session is built, so a change on disk (a new
 * plugin, an updated one) only reaches a chat once its session is rebuilt.
 */
export async function POST() {
  const authResult = await requirePermission("admin", "plugins");
  if (!authResult.ok) return authResult.response;

  invalidatePluginCache();
  try {
    const evicted = await evictAllSessions();
    return NextResponse.json({ evicted });
  } catch (err) {
    console.error("Failed to rebuild pooled sessions:", err);
    return NextResponse.json({ error: "Failed to rebuild sessions" }, { status: 500 });
  }
}
