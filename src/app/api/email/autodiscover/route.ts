import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { autodiscover } from "@/lib/email/autodiscover";

/**
 * POST /api/email/autodiscover — Auto-detect IMAP/SMTP settings for an email address
 *
 * Body: { email: string }
 * Response: { imap?: { host, port, secure }, smtp?: { host, port, secure }, source: "srv" | "probe" | null }
 */
export async function POST(request: NextRequest) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const body = await request.json();
  const { email } = body;

  if (!email || typeof email !== "string" || !email.includes("@")) {
    return NextResponse.json({ error: "Valid email address required" }, { status: 400 });
  }

  const result = await autodiscover(email);

  return NextResponse.json(result);
}
