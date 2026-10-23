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
 * Postgres caps bind parameters at 65535; keep `in` lists comfortably under
 * that so a very large folder cannot blow up a single query.
 */
const UIDS_PER_QUERY = 5000;
/** createMany binds every column of every row (10 here); keep batches well under the cap. */
const CREATE_BATCH_SIZE = 2000;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/** An IMAP envelope, parsed once, ready to be written. */
interface ParsedEmailRow {
  uid: string;
  data: {
    uid: string;
    fromName: string | null;
    fromEmail: string;
    to: string;
    subject: string;
    /** imapflow hands this over as `Date | string`; Postgres accepts both. */
    date: Date | string;
    folder: string;
    isRead: boolean;
    isStarred: boolean;
  };
}

/**
 * Parse an IMAP envelope into its DB row (headers only).
 *
 * Body fields are left alone: a message already in the DB keeps the body that
 * was fetched when it was last opened. Nulling them here would blank out
 * today's mail on every run, because `SINCE` matches by day and re-fetches the
 * whole of today each time.
 */
function parseEmailRow(msg: FetchMessageObject, folder: string): ParsedEmailRow {
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

  return {
    uid,
    data: {
      uid,
      fromName: sanitizePostgresString(fromName),
      fromEmail: sanitizePostgresString(fromEmail) ?? "",
      to: sanitizePostgresString(toList) ?? "",
      subject: sanitizePostgresString(subject) ?? "(no subject)",
      date,
      folder,
      isRead: flagsArray.includes("\\Seen"),
      isStarred: flagsArray.includes("\\Flagged"),
    },
  };
}

/**
 * Upsert a batch of envelopes in as few round trips as possible: one
 * existence lookup per chunk of UIDs, one `createMany` for the new rows, one
 * update per existing row. The old code made a findUnique plus a write per
 * message, which dominates the run on a busy INBOX.
 *
 * A single failing row is reported against its UID and does not stop the
 * batch, matching the old per-message behaviour.
 */
async function upsertEmailMessages(
  messages: FetchMessageObject[],
  accountId: string,
  folder: string,
): Promise<{ created: number; updated: number; errors: string[] }> {
  const parsed = messages.map((msg) => parseEmailRow(msg, folder));
  const errors: string[] = [];

  // Which UIDs already have a row in this account + folder.
  const byUid = new Map<string, string>();
  for (const uidChunk of chunk(
    parsed.map((p) => p.uid),
    UIDS_PER_QUERY,
  )) {
    const existing = await prisma.emailMessage.findMany({
      where: { accountId, folder, uid: { in: uidChunk } },
      select: { uid: true, id: true },
    });
    for (const row of existing) byUid.set(row.uid, row.id);
  }

  const toCreate = parsed.filter((p) => !byUid.has(p.uid));
  const toUpdate = parsed.filter((p) => byUid.has(p.uid));

  let created = 0;
  for (const batch of chunk(toCreate, CREATE_BATCH_SIZE)) {
    const rows = batch.map((p) => ({ ...p.data, accountId }));
    try {
      await prisma.emailMessage.createMany({ data: rows });
      created += rows.length;
    } catch (err) {
      // A single bad row would otherwise discard the whole batch; retry
      // message by message so one error does not block the rest.
      const batchErr = err as Error;
      console.error(
        `[email-sync] Bulk create in ${folder} failed, retrying per message:`,
        batchErr.message,
        batchErr.cause,
      );
      for (const row of rows) {
        try {
          await prisma.emailMessage.create({ data: row });
          created++;
        } catch (rowErr) {
          const msgErr = rowErr as Error;
          console.error(
            `[email-sync] Failed to create message UID ${row.uid} in ${folder}:`,
            msgErr.message,
            msgErr.cause,
          );
          errors.push(
            `Failed to process message UID ${row.uid}: ${msgErr.message}${msgErr.cause ? ` (${String(msgErr.cause)})` : ""}`,
          );
        }
      }
    }
  }

  let updated = 0;
  for (const p of toUpdate) {
    const id = byUid.get(p.uid);
    if (!id) continue;
    try {
      await prisma.emailMessage.update({ where: { id }, data: p.data });
      updated++;
    } catch (err) {
      const msgErr = err as Error;
      console.error(
        `[email-sync] Failed to update message UID ${p.uid} in ${folder}:`,
        msgErr.message,
        msgErr.cause,
      );
      errors.push(
        `Failed to process message UID ${p.uid}: ${msgErr.message}${msgErr.cause ? ` (${String(msgErr.cause)})` : ""}`,
      );
    }
  }

  return { created, updated, errors };
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

        // Collect the folder's envelopes, then upsert them as a batch: the
        // old per-message loop made one existence check plus one write per
        // message, which dominated the run on a busy INBOX.
        const envelopes: FetchMessageObject[] = [];
        for await (const msg of mailbox.fetch(uids, fetchOpts)) {
          envelopes.push(msg);
        }

        const outcome = await upsertEmailMessages(envelopes, accountId, folder);
        newMessages += outcome.created;
        updatedMessages += outcome.updated;
        errors.push(...outcome.errors);
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
