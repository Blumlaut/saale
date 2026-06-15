import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireAccountOwner, sanitizeError } from "@/lib/auth";
import { decrypt } from "@/lib/crypto";
import { sendEmail } from "@/lib/email/smtp";

/**
 * POST /api/email/accounts/:accountId/send — Send an email
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ accountId: string }> },
) {
  const { accountId } = await params;

  const authResult = await requireAccountOwner(accountId);
  if (!authResult.ok) return authResult.response;
  const { account } = authResult;

  const body = await request.json();
  const { to, subject, body: emailBody, bodyHtml, replyTo, cc, bcc } = body;

  if (!to || !subject) {
    return NextResponse.json({ error: "To and subject are required" }, { status: 400 });
  }

  // Validate subject length
  if (typeof subject === "string" && subject.length > 998) {
    return NextResponse.json({ error: "Subject must be 998 characters or less" }, { status: 400 });
  }

  const password = decrypt(account.encryptedPassword);

  try {
    const result = await sendEmail({
      account,
      password,
      to: Array.isArray(to) ? to : [to],
      subject,
      body: emailBody || "",
      bodyHtml,
      replyTo,
      cc,
      bcc,
    });

    return NextResponse.json({
      sent: true,
      messageId: result.messageId,
    });
  } catch (err) {
    return NextResponse.json({ error: sanitizeError(err) }, { status: 500 });
  }
}
