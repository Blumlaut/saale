import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/crypto";

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

    const lastSyncedAt = account.lastSyncedAt;
    const folders = ["INBOX", "Sent", "Drafts", "Archive", "Trash"];

    for (const folder of folders) {
      try {
        await (
          mailbox as unknown as {
            openMailbox: (name: string, opts: { readOnly: boolean }) => Promise<void>;
          }
        ).openMailbox(folder, { readOnly: true });

        // Build search criteria
        const searchOpts: Record<string, unknown> = {};
        if (lastSyncedAt) {
          searchOpts.since = lastSyncedAt;
        }

        const uids = await mailbox.search(searchOpts);
        if (!uids || uids.length === 0) {
          continue;
        }

        // Fetch messages
        const fetchOpts: Record<string, unknown> = {
          bodies: ["TEXT"],
          source: true,
        };

        // Process messages from the async iterator
        for await (const msg of mailbox.fetch(uids, fetchOpts)) {
          try {
            const parsed = await simpleParser(msg.source ?? Buffer.alloc(0));
            const uid = String(msg.uid ?? "");

            // Check if message already exists
            const existing = await prisma.emailMessage.findUnique({
              where: {
                accountId_uid: {
                  accountId,
                  uid,
                },
              },
            });

            const toList = Array.isArray(parsed.to)
              ? parsed.to
                  .map((a) =>
                    typeof a === "object" && a
                      ? String((a as { address?: string }).address || a)
                      : String(a),
                  )
                  .join(",")
              : String(parsed.to || "");

            const fromName =
              parsed.from && typeof parsed.from === "object"
                ? "name" in parsed.from
                  ? (parsed.from.name as string) || null
                  : null
                : null;

            const fromEmail =
              parsed.from && typeof parsed.from === "object"
                ? "address" in parsed.from
                  ? (parsed.from.address as string) || ""
                  : ""
                : "";

            const flags = msg.flags ?? new Set<string>();
            const flagsArray = flags instanceof Set ? Array.from(flags) : flags;

            const bodyHtml = parsed.html ? String(parsed.html) : null;

            if (existing) {
              await prisma.emailMessage.update({
                where: { id: existing.id },
                data: {
                  uid,
                  fromName,
                  fromEmail,
                  to: toList,
                  subject: parsed.subject ?? "(no subject)",
                  date: parsed.date ?? new Date(),
                  bodyPreview: parsed.text?.slice(0, 500) ?? "",
                  bodyHtml,
                  bodyText: parsed.text ?? null,
                  folder,
                  isRead: flagsArray.includes("\\Seen") ?? existing.isRead,
                  isStarred: flagsArray.includes("\\Flagged") ?? existing.isStarred,
                },
              });
              updatedMessages++;
            } else {
              await prisma.emailMessage.create({
                data: {
                  accountId,
                  uid,
                  fromName,
                  fromEmail,
                  to: toList,
                  subject: parsed.subject ?? "(no subject)",
                  date: parsed.date ?? new Date(),
                  bodyPreview: parsed.text?.slice(0, 500) ?? "",
                  bodyHtml,
                  bodyText: parsed.text ?? null,
                  folder,
                  isRead: flagsArray.includes("\\Seen") ?? false,
                  isStarred: flagsArray.includes("\\Flagged") ?? false,
                },
              });
              newMessages++;
            }
          } catch (err) {
            errors.push(`Failed to parse message UID ${msg.uid}: ${(err as Error).message}`);
          }
        }
      } catch (err) {
        errors.push(`Failed to sync folder ${folder}: ${(err as Error).message}`);
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

  return { newMessages, updatedMessages, errors };
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
