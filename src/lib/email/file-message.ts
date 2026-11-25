import { prisma } from "@/lib/db";
import { moveMessage } from "@/lib/email/imap";

/**
 * Move one message into a folder on the server and keep its local row in step.
 *
 * The server's answer decides what the row becomes. A UID in the new folder is
 * written to the row, so the message keeps its tags and its id. Without one the
 * row is dropped and the next sync re-adds the message where it now sits, which
 * beats a row claiming a UID that mailbox never had. A move the server refused
 * leaves the row alone, because nothing happened.
 */
export async function fileMessage(params: {
  message: { id: string; accountId: string; folder: string; uid: string };
  destination: string;
}): Promise<{ moved: boolean }> {
  const { message, destination } = params;
  if (destination === message.folder) return { moved: true };

  const outcome = await moveMessage(message.accountId, message.folder, message.uid, destination);
  if (!outcome.moved) return { moved: false };

  if (!outcome.uid) {
    // The message keeps its internal date, so an incremental sync would never
    // look for it in the new folder. Dropping the row and clearing the sync
    // mark makes the next run walk the account and find it where it now is.
    await prisma.emailMessage.delete({ where: { id: message.id } });
    await prisma.emailAccount.update({
      where: { id: message.accountId },
      data: { lastSyncedAt: null },
    });
    return { moved: true };
  }

  try {
    await prisma.emailMessage.update({
      where: { id: message.id },
      data: { folder: destination, uid: outcome.uid },
    });
  } catch (err) {
    // A row for the message already sits at that UID, so this one is the spare.
    console.warn(
      `[email-file] Could not re-file message ${message.id} in ${destination}, dropping the local copy:`,
      err,
    );
    await prisma.emailMessage.delete({ where: { id: message.id } });
  }
  return { moved: true };
}
