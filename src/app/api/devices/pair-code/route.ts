import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { issuePairCode } from "@/lib/devices/pairing";

/**
 * POST /api/devices/pair-code. mint a one-time code to paste into an agent.
 *
 * Minting replaces the user's previous code, so two live codes can never be in
 * circulation for one account.
 */
export async function POST() {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const { code, expiresAt } = await issuePairCode(authResult.user.id);

  return NextResponse.json({ code, expiresAt: expiresAt.toISOString() });
}
