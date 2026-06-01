import { ImapFlow, ListResponse } from "imapflow";
import { simpleParser } from "mailparser";
import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/crypto";

/** Strip null bytes and other invalid UTF-8 codepoints that PostgreSQL rejects */
function sanitize(str: unknown): string | null {
  if (str == null || str === false) return null;
  return String(str).replace(/\0/g, "");
}

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
 * Discover mailbox folders using IMAP LIST.
 * Returns all folders plus special-use matched folders.
 */
async function discoverFolders(
  mailbox: ImapFlow,
): Promise<{ allFolders: string[]; special: Record<string, string | null> }> {
  const special: Record<string, string | null> = {
    "\\Sent": null,
    "\\Drafts": null,
    "\\Trash": null,
    "\\Archive": null,
  };
  const allFolders: string[] = [];

  try {
    const mailboxes: ListResponse[] = await mailbox.list();

    // Collect all folder names (skip INBOX since it's always there)
    for (const mb of mailboxes) {
      if (mb.name.toUpperCase() !== "INBOX") {
        allFolders.push(mb.name);
      }
    }

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

  return { allFolders, special };
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

    // Cache all remote folders on the account
    await prisma.emailAccount.update({
      where: { id: accountId },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Prisma Json type is incompatible with string[]
      data: { cachedFolders: allFolders as any },
    });

    const lastSyncedAt = account.lastSyncedAt;
    // eslint-disable-next-line no-console -- debug logging for sync troubleshooting
    console.log(`[email-sync] lastSyncedAt: ${lastSyncedAt ?? "null (full sync)"}`);

    for (const folder of folders) {
      try {
        await mailbox.mailboxOpen(folder);

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

            // mailparser returns { value: [{ address, name }], html, text }
            // Extract addresses from the value array, fallback to text
            const extractAddresses = (field: unknown): string => {
              if (!field) return "";
              if (typeof field === "string") return field;
              if (Array.isArray(field)) {
                return field
                  .map((a) => {
                    if (typeof a === "string") return a;
                    if (typeof a === "object" && a && "address" in a) return String(a.address);
                    return String(a);
                  })
                  .join(",");
              }
              // mailparser envelope: { value: [...], html, text }
              if (typeof field === "object" && "value" in field && Array.isArray(field.value)) {
                return field.value
                  .map((a) => {
                    if (typeof a === "string") return a;
                    if (typeof a === "object" && a && "address" in a) return String(a.address);
                    return String(a);
                  })
                  .join(",");
              }
              return String(field);
            };

            const toList = extractAddresses(parsed.to);

            // from is also { value: [{ address, name }], html, text }
            const fromField = parsed.from;
            let fromName: string | null = null;
            let fromEmail: string = "";
            if (
              fromField &&
              typeof fromField === "object" &&
              "value" in fromField &&
              Array.isArray(fromField.value) &&
              fromField.value.length > 0
            ) {
              const firstAddr = fromField.value[0];
              if (typeof firstAddr === "object" && firstAddr) {
                fromName = "name" in firstAddr ? (firstAddr.name as string) || null : null;
                fromEmail = "address" in firstAddr ? (firstAddr.address as string) || "" : "";
              }
            } else if (fromField && typeof fromField === "object") {
              // Fallback: direct object with name/address
              fromName = "name" in fromField ? (fromField.name as string) || null : null;
              fromEmail = "address" in fromField ? (fromField.address as string) || "" : "";
            }

            const flags = msg.flags ?? new Set<string>();
            const flagsArray = flags instanceof Set ? Array.from(flags) : flags;

            const bodyHtml = sanitize(parsed.html);

            if (existing) {
              await prisma.emailMessage.update({
                where: { id: existing.id },
                data: {
                  uid,
                  fromName: sanitize(fromName),
                  fromEmail: sanitize(fromEmail) ?? "",
                  to: sanitize(toList) ?? "",
                  subject: sanitize(parsed.subject) ?? "(no subject)",
                  date: parsed.date ?? new Date(),
                  bodyPreview: sanitize(parsed.text?.slice(0, 500)) ?? "",
                  bodyHtml,
                  bodyText: sanitize(parsed.text),
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
                  fromName: sanitize(fromName),
                  fromEmail: sanitize(fromEmail) ?? "",
                  to: sanitize(toList) ?? "",
                  subject: sanitize(parsed.subject) ?? "(no subject)",
                  date: parsed.date ?? new Date(),
                  bodyPreview: sanitize(parsed.text?.slice(0, 500)) ?? "",
                  bodyHtml,
                  bodyText: sanitize(parsed.text),
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
