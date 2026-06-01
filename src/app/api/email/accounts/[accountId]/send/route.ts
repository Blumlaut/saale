import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { headers } from "next/headers";
import { decrypt } from "@/lib/crypto";
import { sendEmail } from "@/lib/email/smtp";

/**
 * POST /api/email/accounts/:accountId/send — Send an email
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ accountId: string }> },
) {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { accountId } = await params;

  const account = await prisma.emailAccount.findFirst({
    where: { id: accountId, userId: session.user.id },
  });

  if (!account) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = await request.json();
  const { to, subject, body: emailBody, bodyHtml, replyTo, cc, bcc } = body;

  if (!to || !subject) {
    return NextResponse.json({ error: "To and subject are required" }, { status: 400 });
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
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
