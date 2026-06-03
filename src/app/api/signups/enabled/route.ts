import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

/**
 * GET /api/signups/enabled — Check if signups are enabled
 * Public endpoint — no auth required
 */
export async function GET() {
  const settings = await prisma.adminSettings.findUnique({
    where: { id: "global" },
    select: { signupsEnabled: true },
  });

  // Default to enabled if settings don't exist yet
  const enabled = settings?.signupsEnabled ?? true;

  return NextResponse.json({ enabled });
}
