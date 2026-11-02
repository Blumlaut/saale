import { NextResponse } from "next/server";

import { requirePermission } from "@/lib/auth";
import { fetchSearchInstance } from "@/lib/web/instance";

/**
 * GET /api/admin/search/engines. The engines the SearXNG instance runs, for the
 * settings page that picks which of them a search may use.
 *
 * The instance's own configuration is the source: it is read on demand, so an
 * engine enabled in SearXNG's settings shows up here on the next reload.
 */
export async function GET() {
  const authResult = await requirePermission("admin", "settings");
  if (!authResult.ok) return authResult.response;

  try {
    return NextResponse.json({ instance: await fetchSearchInstance() });
  } catch (err) {
    // A search instance that is down is an answer this page can show.
    console.error("Failed to read the search instance's configuration:", err);
    const reason = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `The search instance did not report its engines: ${reason}` },
      { status: 502 },
    );
  }
}
