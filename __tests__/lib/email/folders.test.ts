import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ImapFlow, ListResponse } from "imapflow";
import {
  archiveFolder,
  discoverFolders,
  folderTargetFrom,
  resolveFolderRef,
  resolveSentFolder,
  specialFolder,
  trashFolderNames,
} from "@/lib/email/folders";

/** A LIST response with the defaults filled in, so each test states only what it means. */
function mailbox(path: string, flags: string[] = [], specialUse?: string): ListResponse {
  const name = path.split(/[/.]/).pop() ?? path;
  return {
    path,
    pathAsListed: path,
    name,
    delimiter: "/",
    parent: [],
    parentPath: "",
    flags: new Set(flags),
    specialUse,
    listed: true,
    subscribed: true,
  };
}

function fakeMailbox(mailboxes: ListResponse[] | Error) {
  const list = vi.fn(async () => {
    if (mailboxes instanceof Error) throw mailboxes;
    return mailboxes;
  });
  return { mailbox: { list } as unknown as ImapFlow, list };
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("discoverFolders", () => {
  it("maps special-use folders to their full selectable path", async () => {
    const { mailbox: imap } = fakeMailbox([
      mailbox("INBOX", []),
      mailbox("INBOX/Sent", ["\\Sent"], "\\Sent"),
      mailbox("INBOX/Trash", ["\\Trash"], "\\Trash"),
    ]);

    const { special } = await discoverFolders(imap);

    expect(special["\\Sent"]).toBe("INBOX/Sent");
    expect(special["\\Trash"]).toBe("INBOX/Trash");
  });

  it("falls back to a known folder name when the server advertises no special-use", async () => {
    const { mailbox: imap } = fakeMailbox([
      mailbox("INBOX", []),
      mailbox("Gesendet", ["\\HasNoChildren"]),
      mailbox("Papierkorb"),
    ]);

    const { special } = await discoverFolders(imap);

    expect(special["\\Sent"]).toBe("Gesendet");
    expect(special["\\Trash"]).toBe("Papierkorb");
  });

  it("prefers a folder the server flags over a same-named folder it does not", async () => {
    const { mailbox: imap } = fakeMailbox([
      mailbox("Gesendet", ["\\HasNoChildren"], "\\Sent"),
      mailbox("Sent", ["\\Sent"], "\\Sent"),
    ]);

    const { special } = await discoverFolders(imap);

    expect(special["\\Sent"]).toBe("Sent");
  });

  it("follows the flag when it sits on the localized folder name", async () => {
    const { mailbox: imap } = fakeMailbox([
      mailbox("Sent", ["\\HasNoChildren"]),
      mailbox("Gesendet", ["\\Sent"], "\\Sent"),
    ]);

    const { special } = await discoverFolders(imap);

    expect(special["\\Sent"]).toBe("Gesendet");
  });

  it("files into the standard name when the server flags no sent folder", async () => {
    // imapflow guesses \Sent from the name and ranks guesses alphabetically.
    const { mailbox: imap } = fakeMailbox([
      mailbox("Gesendet", ["\\HasNoChildren"], "\\Sent"),
      mailbox("Sent", ["\\HasNoChildren"]),
    ]);

    const { special } = await discoverFolders(imap);

    expect(special["\\Sent"]).toBe("Sent");
  });

  it("skips a folder the server cannot append into", async () => {
    const { mailbox: imap } = fakeMailbox([
      mailbox("Sent", ["\\Sent", "\\Noselect"], "\\Sent"),
      mailbox("Gesendet", ["\\Sent"], "\\Sent"),
    ]);

    const { special } = await discoverFolders(imap);

    expect(special["\\Sent"]).toBe("Gesendet");
  });

  it("lists every selectable mailbox except INBOX", async () => {
    const { mailbox: imap } = fakeMailbox([
      mailbox("INBOX", []),
      mailbox("Sent", ["\\Sent"], "\\Sent"),
      mailbox("Projects", []),
      mailbox("Projects/2026", ["\\Noselect"]),
    ]);

    const { allFolders } = await discoverFolders(imap);

    expect(allFolders).toEqual(["Sent", "Projects"]);
  });

  it("keeps INBOX out of the folder list but still usable as a mailbox", async () => {
    const { mailbox: imap } = fakeMailbox([mailbox("INBOX", ["\\Inbox"], "\\Inbox")]);

    const { allFolders, special } = await discoverFolders(imap);

    expect(allFolders).toEqual([]);
    expect(special["\\Sent"]).toBeNull();
  });

  it("falls back to default names and reports the failure when LIST fails", async () => {
    const { mailbox: imap } = fakeMailbox(new Error("NO Connection dropped"));

    const { allFolders, special } = await discoverFolders(imap);

    expect(allFolders).toEqual([]);
    expect(special["\\Sent"]).toBe("Sent");
    expect(special["\\All"]).toBeNull();
    expect(console.error).toHaveBeenCalledWith(
      "[email-folders] Folder list failed, falling back to default names:",
      expect.any(Error),
    );
  });
});

describe("resolveSentFolder", () => {
  it("uses the mapping cached by the last sync without listing folders", async () => {
    const { mailbox: imap, list } = fakeMailbox([]);

    const folder = await resolveSentFolder(imap, { "\\Sent": "Sent Items" });

    expect(folder).toBe("Sent Items");
    expect(list).not.toHaveBeenCalled();
  });

  it("lists folders for an account that has never synced", async () => {
    const { mailbox: imap, list } = fakeMailbox([mailbox("Sent", ["\\Sent"], "\\Sent")]);

    const folder = await resolveSentFolder(imap, null);

    expect(folder).toBe("Sent");
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("returns null when the server has no Sent folder to file into", async () => {
    const { mailbox: imap } = fakeMailbox([mailbox("INBOX", []), mailbox("Drafts", [])]);

    const folder = await resolveSentFolder(imap, { "\\Sent": null });

    expect(folder).toBeNull();
  });
});

describe("folderTargetFrom", () => {
  it("reads the mailbox facts off an account row", () => {
    const target = folderTargetFrom({
      specialFolders: { "\\Sent": "Sent" },
      cachedFolders: ["Sent", "Gesendet"],
    });

    expect(target.special["\\Sent"]).toBe("Sent");
    expect(target.folders).toEqual(["Sent", "Gesendet"]);
  });

  it("answers for an account that has never synced", () => {
    const target = folderTargetFrom({ specialFolders: null, cachedFolders: null });

    expect(target.special).toEqual({});
    expect(target.folders).toEqual([]);
  });
});

describe("specialFolder", () => {
  it("prefers the mapping the sync resolved", () => {
    const target = folderTargetFrom({
      specialFolders: { "\\Trash": "Papierkorb" },
      cachedFolders: ["Trash", "Papierkorb"],
    });

    expect(specialFolder(target, "\\Trash")).toBe("Papierkorb");
  });

  it("falls back to the known names in their order", () => {
    const target = folderTargetFrom({ cachedFolders: ["Gesendet", "Sent"] });

    expect(specialFolder(target, "\\Sent")).toBe("Sent");
  });

  it("matches a nested path whatever the delimiter", () => {
    const target = folderTargetFrom({ cachedFolders: ["INBOX.Gesendet"] });

    expect(specialFolder(target, "\\Sent")).toBe("INBOX.Gesendet");
  });

  it("does not mistake a user folder for a special one", () => {
    const target = folderTargetFrom({ cachedFolders: ["MySent", "Invoices"] });

    expect(specialFolder(target, "\\Sent")).toBeNull();
  });

  it("answers INBOX without any discovery", () => {
    expect(specialFolder(folderTargetFrom({}), "\\Inbox")).toBe("INBOX");
  });
});

describe("resolveFolderRef", () => {
  const target = folderTargetFrom({
    specialFolders: { "\\Sent": "Gesendet", "\\Trash": "Gelöscht" },
    cachedFolders: ["Gesendet", "Gelöscht", "Projekte"],
  });

  it("resolves a special-use attribute", () => {
    expect(resolveFolderRef(target, "\\Sent")).toBe("Gesendet");
    expect(resolveFolderRef(target, "\\sent")).toBe("Gesendet");
  });

  it("resolves a path the server listed, in any case", () => {
    expect(resolveFolderRef(target, "projekte")).toBe("Projekte");
  });

  it("resolves a well-known name to the folder that account uses", () => {
    expect(resolveFolderRef(target, "Trash")).toBe("Gelöscht");
    expect(resolveFolderRef(target, "Sent")).toBe("Gesendet");
  });

  it("resolves INBOX", () => {
    expect(resolveFolderRef(target, "inbox")).toBe("INBOX");
  });

  it("returns null for a folder the account does not have", () => {
    expect(resolveFolderRef(target, "Archive")).toBeNull();
  });
});

describe("archiveFolder", () => {
  it("uses the archive folder", () => {
    const target = folderTargetFrom({ specialFolders: { "\\Archive": "Archiv" } });

    expect(archiveFolder(target)).toBe("Archiv");
  });

  it("falls back to the all-mail folder, which is where Gmail archives to", () => {
    const target = folderTargetFrom({ specialFolders: { "\\All": "All Mail" } });

    expect(archiveFolder(target)).toBe("All Mail");
  });

  it("reports no archive folder when the server offers neither", () => {
    expect(archiveFolder(folderTargetFrom({ cachedFolders: ["Sent"] }))).toBeNull();
  });
});

describe("trashFolderNames", () => {
  it("names each account's own trash folder", () => {
    const names = trashFolderNames([
      { specialFolders: { "\\Trash": "Gelöscht" } },
      { specialFolders: { "\\Trash": "Trash" } },
    ]);

    expect(names).toEqual(["Gelöscht", "Trash"]);
  });

  it("stands in the known names for an account that never synced", () => {
    const names = trashFolderNames([{ specialFolders: null }]);

    expect(names).toContain("Trash");
    expect(names).toContain("Papierkorb");
  });
});
