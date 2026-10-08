import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ImapFlow, ListResponse } from "imapflow";
import { discoverFolders, resolveSentFolder } from "@/lib/email/folders";

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
