import type { ImapFlow, ListResponse } from "imapflow";

/**
 * Special-use folder attribute → fallback names to try if SPECIAL-USE discovery fails.
 */
export const SPECIAL_USE_FALLBACKS: Record<string, string[]> = {
  "\\Inbox": ["INBOX", "Inbox"],
  "\\Sent": ["Sent", "Sent Messages", "Sent Items", "Gesendet"],
  "\\Drafts": ["Drafts", "Drafts Messages", "Entwurf", "Entwürfe"],
  "\\Trash": ["Trash", "Deleted Messages", "Deleted Items", "Gelöscht", "Papierkorb"],
  "\\Archive": ["Archive", "Archiv", "All Mail"],
};

/** Special-use attribute → resolved mailbox path on this account. */
export type SpecialFolders = Record<string, string | null>;

/**
 * Discover mailbox folders using IMAP LIST.
 * Returns all folders plus special-use matched folders.
 */
export async function discoverFolders(
  mailbox: ImapFlow,
): Promise<{ allFolders: string[]; special: SpecialFolders }> {
  const special: SpecialFolders = {
    "\\Sent": null,
    "\\Drafts": null,
    "\\Trash": null,
    "\\Archive": null,
  };
  const allFolders: string[] = [];

  try {
    const mailboxes: ListResponse[] = await mailbox.list();

    // Collect all folder paths (skip INBOX and \Noselect parent folders).
    // Use mb.path (full selectable path like "INBOX/Zapx") instead of mb.name
    // (last segment only like "Zapx"). mailboxOpen() needs the full path.
    for (const mb of mailboxes) {
      if (mb.name.toUpperCase() === "INBOX") continue;
      const attrs = mb.flags ?? new Set<string>();
      if (attrs.has("\\Noselect")) continue; // parent container, not selectable
      allFolders.push(mb.path);
    }

    for (const mb of mailboxes) {
      const attrs = mb.flags ?? new Set<string>();

      // Match special-use attributes (check both flags set and specialUse field).
      // Store mb.path (selectable path) instead of mb.name.
      if ((attrs.has("\\Sent") || mb.specialUse === "\\Sent") && !special["\\Sent"]) {
        special["\\Sent"] = mb.path;
      }
      if ((attrs.has("\\Drafts") || mb.specialUse === "\\Drafts") && !special["\\Drafts"]) {
        special["\\Drafts"] = mb.path;
      }
      if ((attrs.has("\\Trash") || mb.specialUse === "\\Trash") && !special["\\Trash"]) {
        special["\\Trash"] = mb.path;
      }
      if ((attrs.has("\\Archive") || mb.specialUse === "\\Archive") && !special["\\Archive"]) {
        special["\\Archive"] = mb.path;
      }
    }

    // Fill in any gaps with fallback name matching (case-insensitive)
    for (const [attr, fallbacks] of Object.entries(SPECIAL_USE_FALLBACKS)) {
      if (attr === "\\Inbox") continue; // INBOX is always "INBOX"
      if (special[attr]) continue; // already found

      for (const fallback of fallbacks) {
        const match = mailboxes.find((mb) => mb.name.toLowerCase() === fallback.toLowerCase());
        if (match) {
          special[attr] = match.path;
          break;
        }
      }
    }
  } catch (err) {
    console.error("[email-folders] Folder list failed, falling back to default names:", err);
    for (const attr of Object.keys(special)) {
      const fallbacks = SPECIAL_USE_FALLBACKS[attr];
      const firstFallback = fallbacks?.[0];
      if (firstFallback) {
        special[attr] = firstFallback;
      }
    }
  }

  return { allFolders, special };
}

/**
 * Resolve the mailbox a copy of a sent message belongs in.
 *
 * Prefers the `\Sent` mapping cached by the last sync. a send must not pay for
 * a LIST when the answer is already on the account row. and falls back to a
 * live LIST for accounts that have never synced.
 */
export async function resolveSentFolder(
  mailbox: ImapFlow,
  cachedSpecial: unknown,
): Promise<string | null> {
  const cached = (cachedSpecial as SpecialFolders | null)?.["\\Sent"];
  if (cached) return cached;

  const { special } = await discoverFolders(mailbox);
  return special["\\Sent"] ?? null;
}
