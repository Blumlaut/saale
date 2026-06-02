import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { testImapConnection } from "@/lib/email/sync";
import { testSmtpConnection } from "@/lib/email/smtp";

/**
 * POST /api/email/test-connection — Test IMAP/SMTP connection without saving
 */
export async function POST(request: NextRequest) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const body = await request.json();
  const { email, imapHost, imapPort, imapSecure, smtpHost, smtpPort, smtpSecure, password } = body;

  if (!email || !password) {
    return NextResponse.json({ error: "Email and password are required" }, { status: 400 });
  }

  const results: Record<string, { success: boolean; error?: string }> = {};

  // Test IMAP
  if (imapHost) {
    results.imap = await testImapConnection({
      host: imapHost,
      port: imapPort ?? 993,
      secure: imapSecure ?? true,
      email,
      password,
    });
  }

  // Test SMTP
  if (smtpHost) {
    results.smtp = await testSmtpConnection({
      host: smtpHost,
      port: smtpPort ?? 465,
      secure: smtpSecure ?? true,
      email,
      password,
    });
  }

  return NextResponse.json({ results });
}
