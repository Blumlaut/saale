import type { FetchMessageObject, MessageAddressObject, MessageEnvelopeObject } from "imapflow";
import { ImapFlow } from "imapflow";
import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { discoverFolders } from "@/lib/email/folders";
import { sanitizePostgresString } from "@/lib/email/utils";

/**
 * Extract a comma-separated address list from an imapflow address array.
 */
function addressesToString(addrs: MessageAddressObject[] | undefined): string {
  if (!addrs || addrs.length === 0) return "";
  return addrs.map((a) => a.address ?? "").join(",");
}

/**
 * Upsert a single message from its IMAP envelope (headers only).
 *
 * Body fields are left alone: a message already in the DB keeps the body that
 * was fetched when it was last opened. Nulling them here would blank out
 * today's mail on every run, because `SINCE` matches by day and re-fetches the
 * whole of today each time.
 *
 * Returns whether the row was new, which is what the sync reports to the user.
 */
async function syncMessageFromEnvelope(
  msg: FetchMessageObject,
  accountId: string,
  folder: string,
): Promise<"created" | "updated"> {
  const uid = String(msg.uid ?? "");
  const envelope = msg.envelope as MessageEnvelopeObject | undefined;
  const flags = msg.flags ?? new Set<string>();
  const flagsArray = flags instanceof Set ? Array.from(flags) : [];

  const fromAddr = envelope?.from?.[0];
  const fromName = fromAddr?.name || null;
  const fromEmail = fromAddr?.address || "";
  const toList = addressesToString(envelope?.to);
  const subject = envelope?.subject || "(no subject)";
  const date = envelope?.date || new Date();

  const existing = await prisma.emailMessage.findUnique({
    where: {
      accountId_folder_uid: {
        accountId,
        folder,
        uid,
      },
    },
  });

  const updateData = {
    uid,
    fromName: sanitizePostgresString(fromName),
    fromEmail: sanitizePostgresString(fromEmail) ?? "",
    to: sanitizePostgresString(toList) ?? "",
    subject: sanitizePostgresString(subject) ?? "(no subject)",
    date,
    folder,
    isRead: flagsArray.includes("\\Seen"),
    isStarred: flagsArray.includes("\\Flagged"),
  };

  if (existing) {
    await prisma.emailMessage.update({
      where: { id: existing.id },
      data: updateData,
    });
    return "updated";
  }

  await prisma.emailMessage.create({
    data: { ...updateData, accountId },
  });
  return "created";
}

/**
 * Sync a single email account via IMAP.
 * Uses incremental sync based on lastSyncedAt timestamp.
 */
export async function syncEmailAccount(accountId: string): Promise<{
  newMessages: number;
  updatedMessages: number;
  errors: string[];
}> {
  const account = await prisma.emailAccount.findUnique({
    where: { id: accountId },
  });

  if (!account || !account.enabled) {
    throw new Error(`Email account ${accountId} not found or disabled`);
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

  let newMessages = 0;
  let updatedMessages = 0;
  const errors: string[] = [];

  try {
    await mailbox.connect();

    // Discover actual folder names from the server
    const { allFolders, special } = await discoverFolders(mailbox);
    // Sync all folders, not just special-use ones
    const folders: string[] = ["INBOX", ...allFolders];
    // eslint-disable-next-line no-console -- debug logging for sync troubleshooting
    console.log(`[email-sync] Syncing folders: ${folders.join(", ")}`);
    // eslint-disable-next-line no-console -- debug logging for sync troubleshooting
    console.log(`[email-sync] Special-use map: ${JSON.stringify(special)}`);

    // Cache all remote folders and special-use mapping on the account
    await prisma.emailAccount.update({
      where: { id: accountId },
      data: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Prisma Json type
        cachedFolders: allFolders as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Prisma Json type
        specialFolders: special as any,
      },
    });

    const lastSyncedAt = account.lastSyncedAt;
    // eslint-disable-next-line no-console -- debug logging for sync troubleshooting
    console.log(`[email-sync] lastSyncedAt: ${lastSyncedAt ?? "null (full sync)"}`);

    for (const folder of folders) {
      try {
        await mailbox.mailboxOpen(folder);
        // eslint-disable-next-line no-console -- debug logging for sync troubleshooting
        console.log(`[email-sync] Folder ${folder}: opened`);

        // Build search criteria
        const searchOpts: Record<string, unknown> = {};
        if (lastSyncedAt) {
          searchOpts.since = lastSyncedAt;
        }

        const uids = await mailbox.search(searchOpts);
        const uidCount = Array.isArray(uids) ? uids.length : 0;
        // eslint-disable-next-line no-console -- debug logging for sync troubleshooting
        console.log(`[email-sync] Folder ${folder}: ${uidCount} messages found`);
        if (!uids || uids.length === 0) {
          continue;
        }

        // Fetch only headers (envelope + flags). bodies are fetched on-demand
        const fetchOpts: Record<string, unknown> = {
          uid: true,
          envelope: true,
          flags: true,
        };

        // Process messages from the async iterator
        for await (const msg of mailbox.fetch(uids, fetchOpts)) {
          try {
            const outcome = await syncMessageFromEnvelope(msg, accountId, folder);

            if (outcome === "created") {
              newMessages++;
            } else {
              updatedMessages++;
            }
          } catch (err) {
            const msgErr = err as Error;
            console.error(
              `[email-sync] Failed to process message UID ${msg.uid} in ${folder}:`,
              msgErr.message,
              msgErr.cause,
            );
            errors.push(
              `Failed to process message UID ${msg.uid}: ${msgErr.message}${msgErr.cause ? ` (${String(msgErr.cause)})` : ""}`,
            );
          }
        }
      } catch (err) {
        const folderErr = err as Error & {
          responseStatus?: string;
          responseText?: string;
          executedCommand?: string;
          response?: unknown;
        };
        // Folders that appear in LIST but don't actually exist (e.g. sieve
        // virtual folders on Mailcow). skip silently
        if (folderErr.responseText?.includes("doesn't exist")) {
          // eslint-disable-next-line no-console -- debug logging
          console.log(`[email-sync] Skipping non-existent folder ${folder}`);
        } else {
          console.error(
            `[email-sync] Failed to sync folder ${folder}:`,
            folderErr.message,
            folderErr.responseStatus,
            folderErr.responseText,
            folderErr.executedCommand,
            folderErr.cause,
          );
          const detail = [
            folderErr.responseStatus,
            folderErr.responseText,
            folderErr.cause ? String(folderErr.cause) : null,
          ]
            .filter(Boolean)
            .join(" | ");
          errors.push(
            `Failed to sync folder ${folder}: ${folderErr.message}${detail ? ` (${detail})` : ""}`,
          );
        }
      } finally {
        try {
          await mailbox.mailboxClose();
        } catch {
          // Ignore close errors
        }
      }
    }

    // Update last synced timestamp
    await prisma.emailAccount.update({
      where: { id: accountId },
      data: { lastSyncedAt: new Date() },
    });
  } catch (err) {
    errors.push(`Connection error: ${(err as Error).message}`);
  } finally {
    try {
      await mailbox.logout();
    } catch {
      // Ignore cleanup errors
    }
  }

  // eslint-disable-next-line no-console -- debug logging for sync troubleshooting
  console.log(
    `[email-sync] Done: ${newMessages} new, ${updatedMessages} updated, ${errors.length} errors`,
  );
  if (errors.length > 0) {
    // eslint-disable-next-line no-console -- debug logging for sync troubleshooting
    console.log(`[email-sync] Errors:`, errors);
  }

  await recordSyncOutcome(accountId, errors);

  return { newMessages, updatedMessages, errors };
}

/** Longest error string kept on the account row. enough to identify the cause. */
const MAX_SYNC_ERROR_LENGTH = 500;

/**
 * Persist the result of a sync attempt on the account.
 *
 * Without this an account pointing at a server that rejects its credentials is
 * indistinguishable from an empty mailbox: the row says "0 messages", the
 * refresh job keeps failing in the server log, and nothing tells the user.
 */
async function recordSyncOutcome(accountId: string, errors: string[]): Promise<void> {
  try {
    if (errors.length === 0) {
      await prisma.emailAccount.update({
        where: { id: accountId },
        data: { lastSyncError: null, lastSyncErrorAt: null },
      });
      return;
    }

    await prisma.emailAccount.update({
      where: { id: accountId },
      data: {
        lastSyncError: sanitizePostgresString(errors.join("; ").slice(0, MAX_SYNC_ERROR_LENGTH)),
        lastSyncErrorAt: new Date(),
      },
    });
  } catch (err) {
    console.error(`Failed to record sync outcome for email account ${accountId}:`, err);
  }
}

/**
 * Test an IMAP connection without syncing.
 */
export async function testImapConnection(params: {
  host: string;
  port: number;
  secure: boolean;
  email: string;
  password: string;
}): Promise<{ success: boolean; error?: string }> {
  const mailbox = new ImapFlow({
    host: params.host,
    port: params.port,
    secure: params.secure,
    auth: {
      user: params.email,
      pass: params.password,
    },
  });

  try {
    await mailbox.connect();
    await mailbox.logout();
    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: (err as Error).message,
    };
  }
}
