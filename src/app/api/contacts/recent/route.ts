import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { getRecentRecipients } from "@/lib/contacts/contacts";

/**
 * GET /api/contacts/recent. Most recent recipients from the user's Sent
 * folders. Feeds the compose picker's suggestions for addresses that are not
 * in the contact book yet.
 */
export async function GET(request: NextRequest) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const { searchParams } = new URL(request.url);
  const limit = Math.min(parseInt(searchParams.get("limit") ?? "25", 10) || 25, 100);

  try {
    const recipients = await getRecentRecipients(authResult.user.id, limit);
    return NextResponse.json({ recipients });
  } catch (err) {
    console.error("Failed to load recent recipients:", err);
    return NextResponse.json({ error: "Failed to load recent recipients" }, { status: 500 });
  }
}
