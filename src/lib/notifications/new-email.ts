/**
 * "New mail" notifications.
 *
 * A sync of a busy mailbox finds dozens of messages at once, so a notification
 * per message would be unusable. One notification per account summarises the
 * batch instead, and the in-app bell keeps a record of what arrived.
 */
import { notifyUser } from "./notify";

/** A message the sync just created, as the notification describes it. */
export interface NewMailSummary {
  fromName: string | null;
  fromEmail: string;
  subject: string;
}

/** How many senders a notification names before it summarises the rest. */
const MAX_LISTED = 3;

/** A subject longer than this is cut. a notification body is one glance long. */
const MAX_SUBJECT_LENGTH = 80;

function describe(message: NewMailSummary): string {
  const sender = message.fromName?.trim() || message.fromEmail || "Unknown sender";
  const subject = message.subject.trim() || "(no subject)";
  const shortened =
    subject.length > MAX_SUBJECT_LENGTH ? `${subject.slice(0, MAX_SUBJECT_LENGTH - 1)}…` : subject;
  return `${sender}: ${shortened}`;
}

/**
 * Notify a user that mail arrived in one of their accounts.
 *
 * Never throws: a sync that found mail must not fail because a phone was
 * unreachable.
 */
export async function notifyNewMail(params: {
  userId: string;
  accountId: string;
  /** The mailbox address, so a user with several accounts knows which one. */
  address: string;
  /** The newest messages. A long batch keeps only the first few. */
  messages: NewMailSummary[];
  /** How many messages arrived in total, which can exceed `messages`. */
  total: number;
}): Promise<void> {
  const { userId, accountId, address, messages, total } = params;
  if (total <= 0 || messages.length === 0) return;

  const listed = messages.slice(0, MAX_LISTED).map(describe);
  const remaining = total - listed.length;
  const body = [...listed, ...(remaining > 0 ? [`and ${remaining} more`] : [])].join("\n");

  await notifyUser({
    userId,
    category: "email",
    title: total === 1 ? `New mail in ${address}` : `${total} new emails in ${address}`,
    body,
    url: "/dashboard/mail",
    // One tag per account: a second batch replaces the first instead of
    // stacking, while another account's mail still shows separately.
    tag: `mail-${accountId}`,
    inApp: true,
  });
}
