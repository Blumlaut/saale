import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { headers } from "next/headers";
import { autodiscover } from "@/lib/email/autodiscover";

/**
 * POST /api/email/autodiscover — Auto-detect IMAP/SMTP settings for an email address
 *
 * Body: { email: string }
 * Response: { imap?: { host, port, secure }, smtp?: { host, port, secure }, source: "srv" | "probe" | null }
 */
export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const { email } = body;

  if (!email || typeof email !== "string" || !email.includes("@")) {
    return NextResponse.json({ error: "Valid email address required" }, { status: 400 });
  }

  const result = await autodiscover(email);

  return NextResponse.json(result);
}
