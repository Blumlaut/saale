import { ImapFlow, ListResponse } from "imapflow";
import { simpleParser } from "mailparser";
import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/crypto";

/**
 * Special-use folder attribute → fallback names to try if SPECIAL-USE discovery fails.
 */
const SPECIAL_USE_FALLBACKS: Record<string, string[]> = {
  "\\Inbox": ["INBOX", "Inbox"],
  "\\Sent": ["Sent", "Sent Messages", "Sent Items", "Gesendet"],
  "\\Drafts": ["Drafts", "Drafts Messages", "Entwurf", "Entwürfe"],
  "\\Trash": ["Trash", "Deleted Messages", "Deleted Items", "Gelöscht", "Papierkorb"],
  "\\Archive": ["Archive", "Archiv", "All Mail"],
};

/**
 * Discover mailbox folders using IMAP SPECIAL-USE flags.
 * Falls back to common folder name patterns if SPECIAL-USE is unavailable.
 */
async function discoverFolders(
  mailbox: ImapFlow,
): Promise<{ inbox: string; special: Record<string, string | null> }> {
  const special: Record<string, string | null> = {
    "\\Sent": null,
    "\\Drafts": null,
    "\\Trash": null,
    "\\Archive": null,
  };

  try {
    const mailboxes: ListResponse[] = await mailbox.list();

    for (const mb of mailboxes) {
      const attrs = mb.flags ?? new Set<string>();
      const name = mb.name;

      // Match special-use attributes (check both flags set and specialUse field)
      if ((attrs.has("\\Sent") || mb.specialUse === "\\Sent") && !special["\\Sent"]) {
        special["\\Sent"] = name;
      }
      if ((attrs.has("\\Drafts") || mb.specialUse === "\\Drafts") && !special["\\Drafts"]) {
        special["\\Drafts"] = name;
      }
      if ((attrs.has("\\Trash") || mb.specialUse === "\\Trash") && !special["\\Trash"]) {
        special["\\Trash"] = name;
      }
      if ((attrs.has("\\Archive") || mb.specialUse === "\\Archive") && !special["\\Archive"]) {
        special["\\Archive"] = name;
      }
    }

    // Fill in any gaps with fallback name matching (case-insensitive)
    for (const [attr, fallbacks] of Object.entries(SPECIAL_USE_FALLBACKS)) {
      if (attr === "\\Inbox") continue; // INBOX is always "INBOX"
      if (special[attr as keyof typeof special]) continue; // already found

      for (const fallback of fallbacks) {
        const match = mailboxes.find((mb) => mb.name.toLowerCase() === fallback.toLowerCase());
        if (match) {
          special[attr as keyof typeof special] = match.name;
          break;
        }
      }
    }
  } catch {
    // If listing fails, rely purely on fallback names
    for (const attr of Object.keys(special)) {
      const fallbacks = SPECIAL_USE_FALLBACKS[attr];
      const firstFallback = fallbacks?.[0];
      if (firstFallback) {
        special[attr as keyof typeof special] = firstFallback;
      }
    }
  }

  return { inbox: "INBOX", special };
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
    const { inbox, special } = await discoverFolders(mailbox);
    const folders: string[] = [inbox];
    for (const folderName of Object.values(special)) {
      if (folderName) {
        folders.push(folderName);
      }
    }

    const lastSyncedAt = account.lastSyncedAt;

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
