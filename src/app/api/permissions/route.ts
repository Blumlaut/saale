import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { getRoleAccess } from "@/lib/permissions/check";

export const dynamic = "force-dynamic";

/**
 * GET /api/permissions. the caller's role names and merged grants.
 *
 * The navs and admin screens use this to hide what the API would refuse; they
 * never see another account's grants.
 */
export async function GET() {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  return NextResponse.json(await getRoleAccess(authResult.user.id));
}
