import { NextResponse } from "next/server";
import { areSignupsEnabled } from "@/lib/auth/signups";

/**
 * GET /api/signups/enabled — Check if signups are enabled
 * Public endpoint — no auth required
 */
export async function GET() {
  return NextResponse.json({ enabled: await areSignupsEnabled() });
}
