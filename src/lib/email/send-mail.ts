import { appendSentCopy } from "@/lib/email/imap";
import { sendEmail } from "@/lib/email/smtp";

export interface SendMailParams {
  account: {
    id: string;
    email: string;
    smtpHost: string;
    smtpPort: number;
    smtpSecure: boolean;
  };
  password: string;
  to: string[];
  subject: string;
  body: string;
  bodyHtml?: string;
  replyTo?: string;
  cc?: string[];
  bcc?: string[];
  /** File paths relative to a base directory (e.g. user workspace). */
  attachmentPaths?: string[];
  /** Base directory to resolve attachment paths against. */
  attachmentBaseDir?: string;
}

export interface SendMailResult {
  messageId: string;
  /** Folder the copy was filed in, or null when it could not be filed. */
  sentFolder: string | null;
}

/**
 * Send a message and file a copy of it in the account's Sent folder.
 *
 * SMTP submission alone leaves Sent empty on most servers, so every send has to
 * append its own copy. A message that is already delivered must not be reported
 * as failed because the copy could not be filed — the caller gets `sentFolder:
 * null` instead, so the user hears about it without the send being retried.
 */
export async function sendMailForAccount(params: SendMailParams): Promise<SendMailResult> {
  const { messageId, raw, date } = await sendEmail(params);

  try {
    const { folder } = await appendSentCopy({
      accountId: params.account.id,
      raw,
      date,
    });
    return { messageId, sentFolder: folder };
  } catch (err) {
    console.error(`Failed to file sent mail in account ${params.account.id}:`, err);
    return { messageId, sentFolder: null };
  }
}
