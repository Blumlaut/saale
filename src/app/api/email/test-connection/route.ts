import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { testImapConnection } from "@/lib/email/sync";
import { testSmtpConnection } from "@/lib/email/smtp";

/**
 * POST /api/email/test-connection. Test IMAP/SMTP connection without saving.
 * When `accountId` is given and no password is supplied, the stored
 * credentials are used (needed when editing without changing the password).
 */
export async function POST(request: NextRequest) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const body = await request.json();
  const { imapHost, imapPort, imapSecure, smtpHost, smtpPort, smtpSecure } = body;
  const account = body.accountId
    ? await prisma.emailAccount.findFirst({
        where: { id: body.accountId, userId: authResult.user.id },
      })
    : null;
  if (body.accountId && !account) {
    return NextResponse.json({ error: "Account not found" }, { status: 404 });
  }

  const email = body.email ?? account?.email;
  const password = body.password ?? (account ? decrypt(account.encryptedPassword) : undefined);

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
