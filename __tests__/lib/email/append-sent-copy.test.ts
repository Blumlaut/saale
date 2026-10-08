import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const append = vi.fn();
const list = vi.fn();
const connect = vi.fn();
const logout = vi.fn();

vi.mock("imapflow", () => {
  class MockImapFlow {
    connect = connect;
    logout = logout;
    append = append;
    list = list;
  }

  return { ImapFlow: MockImapFlow };
});

vi.mock("@/lib/db", () => ({
  prisma: {
    emailAccount: { findUnique: vi.fn() },
  },
}));

vi.mock("@/lib/crypto", () => ({
  decrypt: vi.fn(() => "test-password"),
}));

import type { ListResponse } from "imapflow";
import { prisma } from "@/lib/db";
import { appendSentCopy } from "@/lib/email/imap";

function mailbox(path: string, flags: string[] = [], specialUse?: string): ListResponse {
  return {
    path,
    pathAsListed: path,
    name: path.split(/[/.]/).pop() ?? path,
    delimiter: "/",
    parent: [],
    parentPath: "",
    flags: new Set(flags),
    specialUse,
    listed: true,
    subscribed: true,
  };
}

const RAW = Buffer.from("From: me@example.com\r\nSubject: hi\r\n\r\nbody");
const SENT_AT = new Date("2026-10-08T12:00:00.000Z");

function accountWith(specialFolders: unknown) {
  return {
    id: "acc-1",
    email: "me@example.com",
    imapHost: "imap.example.com",
    imapPort: 993,
    imapSecure: true,
    encryptedPassword: "encrypted",
    specialFolders,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  connect.mockResolvedValue(undefined);
  logout.mockResolvedValue(undefined);
  append.mockResolvedValue({ destination: "Sent" });
  vi.mocked(prisma.emailAccount.findUnique).mockResolvedValue(
    accountWith({ "\\Sent": "Sent" }) as never,
  );
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("appendSentCopy", () => {
  it("files the raw message \\Seen in the cached Sent folder", async () => {
    const result = await appendSentCopy({ accountId: "acc-1", raw: RAW, date: SENT_AT });

    expect(append).toHaveBeenCalledWith("Sent", RAW, ["\\Seen"], SENT_AT);
    expect(result).toEqual({ folder: "Sent" });
  });

  it("reports the folder the server actually stored the copy in", async () => {
    append.mockResolvedValue({ destination: "INBOX/Sent", uid: 42 });

    const result = await appendSentCopy({ accountId: "acc-1", raw: RAW, date: SENT_AT });

    expect(result).toEqual({ folder: "INBOX/Sent" });
  });

  it("treats an append the server skipped as a failure, not as filed mail", async () => {
    append.mockResolvedValue(undefined);

    await expect(appendSentCopy({ accountId: "acc-1", raw: RAW, date: SENT_AT })).rejects.toThrow(
      "Server did not store the copy in Sent",
    );
  });

  it("discovers the Sent folder for an account that has never synced", async () => {
    vi.mocked(prisma.emailAccount.findUnique).mockResolvedValue(accountWith(null) as never);
    list.mockResolvedValue([mailbox("INBOX"), mailbox("Sent Items", ["\\Sent"], "\\Sent")]);
    append.mockResolvedValue({ destination: "Sent Items" });

    const result = await appendSentCopy({ accountId: "acc-1", raw: RAW, date: SENT_AT });

    expect(append).toHaveBeenCalledWith("Sent Items", RAW, ["\\Seen"], SENT_AT);
    expect(result).toEqual({ folder: "Sent Items" });
  });

  it("re-lists and retries when the cached Sent folder was renamed", async () => {
    append.mockRejectedValueOnce(new Error("Mailbox doesn't exist: Sent"));
    append.mockResolvedValueOnce({ destination: "Gesendet" });
    list.mockResolvedValue([mailbox("Gesendet", ["\\Sent"], "\\Sent")]);

    const result = await appendSentCopy({ accountId: "acc-1", raw: RAW, date: SENT_AT });

    expect(append).toHaveBeenNthCalledWith(1, "Sent", RAW, ["\\Seen"], SENT_AT);
    expect(append).toHaveBeenNthCalledWith(2, "Gesendet", RAW, ["\\Seen"], SENT_AT);
    expect(result).toEqual({ folder: "Gesendet" });
  });

  it("does not retry forever when the re-listed folder is the one that failed", async () => {
    append.mockRejectedValue(new Error("Permission denied"));
    list.mockResolvedValue([mailbox("Sent", ["\\Sent"], "\\Sent")]);

    await expect(appendSentCopy({ accountId: "acc-1", raw: RAW, date: SENT_AT })).rejects.toThrow(
      "Permission denied",
    );
    expect(append).toHaveBeenCalledTimes(1);
  });

  it("throws when the server has no Sent folder at all", async () => {
    vi.mocked(prisma.emailAccount.findUnique).mockResolvedValue(accountWith(null) as never);
    list.mockResolvedValue([mailbox("INBOX"), mailbox("Drafts", ["\\Drafts"], "\\Drafts")]);

    await expect(appendSentCopy({ accountId: "acc-1", raw: RAW, date: SENT_AT })).rejects.toThrow(
      "No Sent folder found on the mail server",
    );
    expect(append).not.toHaveBeenCalled();
  });

  it("always drops the IMAP connection, even when the append fails", async () => {
    append.mockRejectedValue(new Error("Permission denied"));
    list.mockRejectedValue(new Error("LIST refused"));

    await expect(appendSentCopy({ accountId: "acc-1", raw: RAW, date: SENT_AT })).rejects.toThrow(
      "Permission denied",
    );

    expect(logout).toHaveBeenCalled();
  });
});
