import { ImapFlow } from "imapflow";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { simpleParser } from "mailparser";
import { discoverFolders, resolveSentFolder } from "@/lib/email/folders";
import { sanitizeEmailHtml } from "@/lib/email/sanitize-html";
import { sanitizePostgresString } from "@/lib/email/utils";

/**
 * IMAP flag constants mapped to our local fields.
 */
const FLAG_SEEN = "\\Seen";
const FLAG_FLAGGED = "\\Flagged";

/**
 * Connect to an IMAP server for an email account.
 * Returns an ImapFlow instance. caller is responsible for logout().
 */
export async function connectImap(accountId: string): Promise<{
  mailbox: ImapFlow;
  email: string;
  /** Special-use folder mapping cached by the last sync. */
  specialFolders: Prisma.JsonValue | null;
}> {
  const account = await prisma.emailAccount.findUnique({
    where: { id: accountId },
  });

  if (!account) {
    throw new Error(`Email account ${accountId} not found`);
  }

  const password = decrypt(account.encryptedPassword);

  const mailbox = new ImapFlow({
    host: account.imapHost,
    port: account.imapPort,
    secure: account.imapSecure,
    auth: {
      user: account.email,
      pass: password,
    },
  });

  await mailbox.connect();
  return { mailbox, email: account.email, specialFolders: account.specialFolders };
}

/**
 * Convert a UID (stored as string in DB) to a number for imapflow.
 */
function toUid(value: string | number): number {
  return typeof value === "string" ? Number(value) : value;
}

/**
 * Set IMAP flags on a message.
 *
 * @param accountId - The email account ID
 * @param folder - The folder containing the message
 * @param uid - The IMAP UID of the message
 * @param isRead - Whether to set/remove \Seen
 * @param isStarred - Whether to set/remove \Flagged
 *
 * Best-effort: does not throw if the server is unreachable.
 */
export async function syncMessageFlags(
  accountId: string,
  folder: string,
  uid: string | number,
  options: { isRead?: boolean; isStarred?: boolean },
): Promise<void> {
  const { mailbox } = await connectImap(accountId);
  const numericUid = toUid(uid);

  try {
    await mailbox.mailboxOpen(folder);

    const flagsToSet: string[] = [];
    const flagsToRemove: string[] = [];

    if (options.isRead !== undefined) {
      if (options.isRead) {
        flagsToSet.push(FLAG_SEEN);
      } else {
        flagsToRemove.push(FLAG_SEEN);
      }
    }

    if (options.isStarred !== undefined) {
      if (options.isStarred) {
        flagsToSet.push(FLAG_FLAGGED);
      } else {
        flagsToRemove.push(FLAG_FLAGGED);
      }
    }

    if (flagsToSet.length > 0) {
      await mailbox.messageFlagsAdd([numericUid], flagsToSet, { uid: true });
    }

    if (flagsToRemove.length > 0) {
      await mailbox.messageFlagsRemove([numericUid], flagsToRemove, { uid: true });
    }
  } catch {
    // Best-effort: log but don't fail the operation
    console.warn(`[imap] Failed to sync flags for UID ${uid} in ${folder} (account ${accountId})`);
  } finally {
    try {
      await mailbox.mailboxClose();
      await mailbox.logout();
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * File a copy of a sent message in the account's Sent folder.
 *
 * Submitting over SMTP only delivers the message: unlike Gmail and Outlook,
 * an ordinary Dovecot/Postfix account keeps no copy of it, so the client has to
 * append one. The copy is marked \Seen and carries the Message-ID of the
 * delivered message, so a server that does save its own copy (or a mail client
 * that later syncs) recognises the two as the same mail.
 *
 * Throws when no Sent folder can be resolved or the server refuses the append
 * the caller decides whether that should reach the user.
 */
export async function appendSentCopy(params: {
  accountId: string;
  raw: Buffer;
  date: Date;
}): Promise<{ folder: string }> {
  const { mailbox, specialFolders } = await connectImap(params.accountId);

  const appendTo = async (folder: string) => {
    const result = await mailbox.append(folder, params.raw, [FLAG_SEEN], params.date);
    // A falsy result means imapflow skipped the command; reporting that as
    // filed would be the silent loss this copy exists to prevent.
    if (!result) {
      throw new Error(`Server did not store the copy in ${folder}`);
    }
    return result.destination;
  };

  try {
    const folder = await resolveSentFolder(mailbox, specialFolders);
    if (!folder) {
      throw new Error("No Sent folder found on the mail server");
    }

    try {
      return { folder: await appendTo(folder) };
    } catch (err) {
      // A cached mapping goes stale when the folder is renamed server-side;
      // re-listing is cheap next to losing the copy.
      const relisted = await discoverFolders(mailbox).then(({ special }) => special["\\Sent"]);
      if (!relisted || relisted === folder) throw err;

      console.warn(
        `[imap] Retrying sent copy for account ${params.accountId} in renamed folder ${relisted}`,
      );
      return { folder: await appendTo(relisted) };
    }
  } finally {
    try {
      await mailbox.logout();
    } catch (err) {
      console.error(`[imap] Failed to close connection for account ${params.accountId}:`, err);
    }
  }
}

/**
 * Move a message to a different folder on the IMAP server.
 *
 * Best-effort: does not throw if the server is unreachable.
 */
export async function moveMessage(
  accountId: string,
  folder: string,
  uid: string | number,
  destination: string,
): Promise<void> {
  const { mailbox } = await connectImap(accountId);
  const numericUid = toUid(uid);

  try {
    await mailbox.mailboxOpen(folder);
    await mailbox.messageMove([numericUid], destination, { uid: true });
  } catch {
    console.warn(
      `[imap] Failed to move UID ${uid} from ${folder} to ${destination} (account ${accountId})`,
    );
  } finally {
    try {
      await mailbox.mailboxClose();
      await mailbox.logout();
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Delete a message on the IMAP server by setting the \Deleted flag.
 *
 * This marks the message for deletion. The server will expunge it on
 * the next CHECK/EXPUNGE or when the mailbox is closed.
 *
 * Best-effort: does not throw if the server is unreachable.
 */
export async function deleteMessage(
  accountId: string,
  folder: string,
  uid: string | number,
): Promise<void> {
  const { mailbox } = await connectImap(accountId);
  const numericUid = toUid(uid);

  try {
    await mailbox.mailboxOpen(folder);
    await mailbox.messageDelete([numericUid], { uid: true });
  } catch {
    console.warn(`[imap] Failed to delete UID ${uid} from ${folder} (account ${accountId})`);
  } finally {
    try {
      await mailbox.mailboxClose();
      await mailbox.logout();
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Batch-sync multiple messages' flags to the IMAP server.
 *
 * Groups messages by folder to minimize mailbox open/close cycles.
 *
 * Best-effort: does not throw if the server is unreachable.
 */
export async function syncMessagesBatch(
  accountId: string,
  messages: Array<{
    uid: string | number;
    folder: string;
    isRead?: boolean;
    isStarred?: boolean;
  }>,
): Promise<void> {
  if (messages.length === 0) return;

  const { mailbox } = await connectImap(accountId);

  try {
    // Group by folder
    const byFolder = new Map<string, typeof messages>();
    for (const msg of messages) {
      const group = byFolder.get(msg.folder) ?? [];
      group.push(msg);
      byFolder.set(msg.folder, group);
    }

    for (const [folder, group] of byFolder) {
      await mailbox.mailboxOpen(folder);

      // Process each message in the group
      for (const msg of group) {
        const numericUid = toUid(msg.uid);
        const flagsToSet: string[] = [];
        const flagsToRemove: string[] = [];

        if (msg.isRead !== undefined) {
          if (msg.isRead) flagsToSet.push(FLAG_SEEN);
          else flagsToRemove.push(FLAG_SEEN);
        }

        if (msg.isStarred !== undefined) {
          if (msg.isStarred) flagsToSet.push(FLAG_FLAGGED);
          else flagsToRemove.push(FLAG_FLAGGED);
        }

        if (flagsToSet.length > 0) {
          await mailbox.messageFlagsAdd([numericUid], flagsToSet, { uid: true });
        }

        if (flagsToRemove.length > 0) {
          await mailbox.messageFlagsRemove([numericUid], flagsToRemove, { uid: true });
        }
      }

      await mailbox.mailboxClose();
    }
  } catch {
    console.warn(`[imap] Failed batch flag sync for account ${accountId}`);
  } finally {
    try {
      await mailbox.logout();
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Fetch the full message body from IMAP, parse it, and store it in the DB.
 * Returns the updated message with body fields populated, or null on failure.
 */
export async function fetchMessageBody(messageId: string): Promise<{
  bodyPreview: string | null;
  bodyHtml: string | null;
  bodyText: string | null;
} | null> {
  const message = await prisma.emailMessage.findUnique({
    where: { id: messageId },
  });
  if (!message) return null;

  const { mailbox } = await connectImap(message.accountId);

  try {
    await mailbox.mailboxOpen(message.folder);

    const fetched = await mailbox.fetchOne(message.uid, { uid: true, source: true }, { uid: true });
    if (!fetched || !fetched.source) {
      console.warn(`[imap] No source returned for UID ${message.uid} in ${message.folder}`);
      return null;
    }

    const parsed = await simpleParser(fetched.source);
    const bodyHtml = sanitizeEmailHtml(sanitizePostgresString(parsed.html));

    const updated = await prisma.emailMessage.update({
      where: { id: messageId },
      data: {
        bodyPreview: sanitizePostgresString(parsed.text?.slice(0, 500)) ?? null,
        bodyHtml,
        bodyText: sanitizePostgresString(parsed.text),
      },
    });

    return {
      bodyPreview: updated.bodyPreview,
      bodyHtml: updated.bodyHtml,
      bodyText: updated.bodyText,
    };
  } catch (err) {
    console.error(`[imap] Failed to fetch body for message ${messageId}:`, err);
    return null;
  } finally {
    try {
      await mailbox.mailboxClose();
      await mailbox.logout();
    } catch {
      // Ignore cleanup errors
    }
  }
}
