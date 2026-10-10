import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireAccountOwner, sanitizeError } from "@/lib/auth";
import { decrypt } from "@/lib/crypto";
import { sendMailForAccount } from "@/lib/email/send-mail";
import { learnContactsFromSend } from "@/lib/contacts/contacts";

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

  // Normalise recipients once — the send and the contact learner share it.
  const toArr = (Array.isArray(to) ? to : [to]) as string[];
  const ccArr = Array.isArray(cc) ? (cc as string[]) : cc ? [cc as string] : null;

  try {
    const result = await sendMailForAccount({
      account,
      password,
      to: toArr,
      subject,
      body: emailBody || "",
      bodyHtml,
      replyTo,
      ...(ccArr ? { cc: ccArr } : {}),
      bcc,
    });

    // Grow the contact book from this send — fire-and-forget; the book must
    // not fail the send.
    learnContactsFromSend(account.userId, toArr, ccArr ?? undefined).catch((err) => {
      console.error("Failed to learn contacts from send:", err);
    });

    return NextResponse.json({
      sent: true,
      messageId: result.messageId,
      sentFolder: result.sentFolder,
    });
  } catch (err) {
    return NextResponse.json({ error: sanitizeError(err) }, { status: 500 });
  }
}
