import type { ImapFlow, ListResponse } from "imapflow";

/**
 * Special-use folder attribute → fallback names to try if SPECIAL-USE discovery fails.
 * Order matters: the first name a server actually has is the one used.
 */
export const SPECIAL_USE_FALLBACKS: Record<string, string[]> = {
  "\\Inbox": ["INBOX", "Inbox"],
  "\\Sent": ["Sent", "Sent Messages", "Sent Items", "Gesendet"],
  "\\Drafts": ["Drafts", "Drafts Messages", "Entwurf", "Entwürfe"],
  "\\Trash": ["Trash", "Deleted Messages", "Deleted Items", "Gelöscht", "Papierkorb"],
  "\\Junk": ["Junk", "Spam", "Junk E-mail", "Spamverdacht"],
  "\\Archive": ["Archive", "Archiv"],
  "\\All": ["All Mail", "All", "Alle Nachrichten"],
};

/** Special-use attribute → resolved mailbox path on this account. */
export type SpecialFolders = Record<string, string | null>;

/** Attributes this module resolves. */
const SPECIAL_ATTRS = ["\\Sent", "\\Drafts", "\\Trash", "\\Junk", "\\Archive", "\\All"] as const;

/** A folder an APPEND can go into. */
function isAppendable(mb: ListResponse): boolean {
  const attrs = mb.flags ?? new Set<string>();
  // A \Noselect container and a \NonExistent leftover hold no message.
  return !attrs.has("\\Noselect") && !attrs.has("\\NonExistent");
}

/** The first folder named, or pathed, like one of the known names, in the order given. */
function byKnownName(mailboxes: ListResponse[], names: string[]): ListResponse | undefined {
  for (const name of names) {
    const wanted = name.toLowerCase();
    const match = mailboxes.find(
      (mb) => mb.name.toLowerCase() === wanted || mb.path.toLowerCase() === wanted,
    );
    if (match) return match;
  }
  return undefined;
}

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
    "\\Junk": null,
    "\\Archive": null,
    "\\All": null,
  };
  const allFolders: string[] = [];

  try {
    const mailboxes: ListResponse[] = await mailbox.list();
    const appendable = mailboxes.filter(isAppendable);

    // Collect all folder paths (skip INBOX and \Noselect parent folders).
    // Use mb.path (full selectable path like "INBOX/Zapx") instead of mb.name
    // (last segment only like "Zapx"). mailboxOpen() needs the full path.
    for (const mb of appendable) {
      if (mb.name.toUpperCase() === "INBOX") continue;
      allFolders.push(mb.path);
    }

    for (const attr of SPECIAL_ATTRS) {
      const flagged = appendable.find((mb) => (mb.flags ?? new Set<string>()).has(attr));
      // imapflow also guesses an attribute from the folder name and ranks the
      // guesses alphabetically, so an account holding both "Sent" and "Gesendet"
      // gets "Gesendet" even when its sent mail is in "Sent". The known names,
      // in their own order, settle a server that flags neither.
      const named = byKnownName(appendable, SPECIAL_USE_FALLBACKS[attr] ?? []);
      const guessed = appendable.find((mb) => mb.specialUse === attr);

      special[attr] = flagged?.path ?? named?.path ?? guessed?.path ?? null;
    }
  } catch (err) {
    console.error("[email-folders] Folder list failed, falling back to default names:", err);
    for (const attr of Object.keys(special)) {
      // Nothing to go on here, so only the everyday folders keep a default name.
      if (attr === "\\All" || attr === "\\Junk") continue;
      const fallbacks = SPECIAL_USE_FALLBACKS[attr];
      const firstFallback = fallbacks?.[0];
      if (firstFallback) {
        special[attr] = firstFallback;
      }
    }
  }

  return { allFolders, special };
}

/** What an account's own rows say about its mailboxes. */
export interface FolderTarget {
  /** Special-use attribute → path, as the last sync resolved it. */
  special: SpecialFolders;
  /** Paths the last sync listed, INBOX aside. */
  folders: string[];
}

/** Read the mailbox facts off an account row. */
export function folderTargetFrom(account: {
  specialFolders?: unknown;
  cachedFolders?: unknown;
}): FolderTarget {
  return {
    special: (account.specialFolders as SpecialFolders | null) ?? {},
    folders: Array.isArray(account.cachedFolders) ? (account.cachedFolders as string[]) : [],
  };
}

/**
 * Whether a path carries a name, whatever delimiter the server joins with, so
 * "INBOX/Sent" and "INBOX.Sent" both answer to "Sent" while "MySent" does not.
 */
function pathCarriesName(path: string, name: string): boolean {
  if (path.toLowerCase() === name.toLowerCase()) return true;
  return new RegExp(`[^\\p{L}\\p{N}]${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "iu").test(
    path,
  );
}

/**
 * A special-use folder's path on this account.
 *
 * The mapping the last sync resolved answers when it can. An account whose
 * server was never asked falls back to the well-known names, in their order.
 */
export function specialFolder(target: FolderTarget, attr: string): string | null {
  if (attr === "\\Inbox") return "INBOX";

  const mapped = target.special[attr];
  if (mapped) return mapped;

  for (const name of SPECIAL_USE_FALLBACKS[attr] ?? []) {
    const path = target.folders.find((folder) => pathCarriesName(folder, name));
    if (path) return path;
  }
  return null;
}

/**
 * The folder a caller's reference points at on this account.
 *
 * Accepts a special-use attribute (`\Sent`), a path the server listed, or one
 * of the well-known names, so "Sent" finds "Gesendet" on a German server.
 */
export function resolveFolderRef(target: FolderTarget, ref: string): string | null {
  const wanted = ref.trim();
  if (!wanted) return null;
  if (wanted.toUpperCase() === "INBOX") return "INBOX";
  if (wanted.startsWith("\\")) return specialFolder(target, canonicalAttr(wanted));

  const exact = target.folders.find((folder) => folder.toLowerCase() === wanted.toLowerCase());
  if (exact) return exact;

  for (const [attr, names] of Object.entries(SPECIAL_USE_FALLBACKS)) {
    if (attr === "\\Inbox") continue;
    if (!names.some((name) => name.toLowerCase() === wanted.toLowerCase())) continue;
    return specialFolder(target, attr);
  }
  return null;
}

/** `\sent` and `\Sent` name the same attribute. */
function canonicalAttr(attr: string): string {
  const bare = attr.slice(1).toLowerCase();
  const known = SPECIAL_ATTRS.find((candidate) => candidate.slice(1).toLowerCase() === bare);
  return known ?? attr;
}

/** The folder an account archives into, or null when its server offers none. */
export function archiveFolder(target: FolderTarget): string | null {
  // Gmail unsets \Inbox for an archived message and files it in \All.
  return specialFolder(target, "\\Archive") ?? specialFolder(target, "\\All");
}

/** Every name this account's trash folder can carry. */
export function trashFolderNames(
  accounts: Array<{
    specialFolders?: unknown;
    cachedFolders?: unknown;
  }>,
): string[] {
  const names = new Set<string>();
  for (const account of accounts) {
    const trash = specialFolder(folderTargetFrom(account), "\\Trash");
    // A never-synced account has no mapping to ask, so the known names stand in.
    for (const name of trash ? [trash] : (SPECIAL_USE_FALLBACKS["\\Trash"] ?? [])) names.add(name);
  }
  return [...names];
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
