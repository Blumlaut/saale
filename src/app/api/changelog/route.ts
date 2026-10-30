import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth";
import { getChangelog } from "@/lib/changelog/read";
import { APP_VERSION } from "@/lib/version";

/**
 * GET /api/changelog. The releases this build knows about, newest first.
 */
export async function GET() {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  return NextResponse.json({ version: APP_VERSION, releases: await getChangelog() });
}
