import { ImapFlow } from "imapflow";
import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/crypto";

/**
 * IMAP flag constants mapped to our local fields.
 */
const FLAG_SEEN = "\\Seen";
const FLAG_FLAGGED = "\\Flagged";

/**
 * Connect to an IMAP server for an email account.
 * Returns an ImapFlow instance — caller is responsible for logout().
 */
export async function connectImap(accountId: string): Promise<{
  mailbox: ImapFlow;
  email: string;
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
  return { mailbox, email: account.email };
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
