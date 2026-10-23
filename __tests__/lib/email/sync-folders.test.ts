import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const openMailbox = { current: "INBOX" };
/** Folder → messages, as the fake server would return them for `fetch`. */
const serverMessages = new Map<string, Record<string, unknown>[]>();
/** Folder → the error `mailboxOpen` should raise for it. */
const folderErrors = new Map<string, Error>();
/** Folder → how many messages `fetch` yields before it fails. */
const fetchFailsAfter = new Map<string, number>();
const mailboxList: Array<{ path: string; name: string; flags: Set<string>; specialUse?: string }> =
  [];

vi.mock("imapflow", () => {
  class MockImapFlow {
    connect = vi.fn().mockResolvedValue(undefined);
    logout = vi.fn().mockResolvedValue(undefined);
    mailboxClose = vi.fn().mockResolvedValue(undefined);
    list = vi.fn(async () => mailboxList);
    mailboxOpen = vi.fn(async (folder: string) => {
      const failure = folderErrors.get(folder);
      if (failure) throw failure;
      openMailbox.current = folder;
    });
    search = vi.fn(async () => (serverMessages.get(openMailbox.current) ?? []).map((m) => m.uid));

    fetch(uids: number[]) {
      const messages = serverMessages.get(openMailbox.current) ?? [];
      const matched = messages.filter((m) => uids.includes(m.uid as number));
      const failAfter = fetchFailsAfter.get(openMailbox.current);
      return (async function* () {
        for (let i = 0; i < matched.length; i++) {
          if (failAfter !== undefined && i >= failAfter) throw new Error("connection lost");
          yield matched[i];
        }
      })();
    }
  }

  return { ImapFlow: MockImapFlow };
});

vi.mock("@/lib/db", () => ({
  prisma: {
    emailAccount: { findUnique: vi.fn(), update: vi.fn() },
    emailMessage: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      createMany: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock("@/lib/crypto", () => ({ decrypt: vi.fn(() => "test-password") }));

import { prisma } from "@/lib/db";
import { syncEmailAccount } from "@/lib/email/sync";

const account = {
  id: "acc-1",
  userId: "user-1",
  email: "me@example.com",
  imapHost: "imap.example.com",
  imapPort: 993,
  imapSecure: true,
  smtpHost: "smtp.example.com",
  smtpPort: 587,
  smtpSecure: false,
  encryptedPassword: "encrypted",
  enabled: true,
  lastSyncedAt: null,
  cachedFolders: null,
  specialFolders: null,
};

function envelope(subject: string, from: string) {
  return {
    from: [{ name: "Sender", address: from }],
    to: [{ address: "me@example.com" }],
    subject,
    date: new Date("2026-10-08T09:00:00.000Z"),
  };
}

/** A message as `mailbox.fetch` hands it to the sync. */
function fetched(uid: number, subject: string, from: string) {
  return { uid, envelope: envelope(subject, from), flags: new Set<string>() };
}

beforeEach(() => {
  vi.clearAllMocks();
  serverMessages.clear();
  folderErrors.clear();
  fetchFailsAfter.clear();
  mailboxList.length = 0;
  vi.mocked(prisma.emailAccount.findUnique).mockResolvedValue(account as never);
  vi.mocked(prisma.emailAccount.update).mockResolvedValue(account as never);
  vi.mocked(prisma.emailMessage.findUnique).mockResolvedValue(null as never);
  vi.mocked(prisma.emailMessage.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.emailMessage.create).mockResolvedValue({} as never);
  vi.mocked(prisma.emailMessage.createMany).mockResolvedValue({ count: 0 } as never);
  vi.mocked(prisma.emailMessage.update).mockResolvedValue({} as never);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("syncEmailAccount folder-scoped messages", () => {
  it("keeps an INBOX message and a Sent message that share a UID apart", async () => {
    mailboxList.push({
      path: "Sent",
      name: "Sent",
      flags: new Set(["\\Sent"]),
      specialUse: "\\Sent",
    });
    // IMAP numbers messages per mailbox: both of these are UID 5.
    serverMessages.set("INBOX", [fetched(5, "Invoice", "alice@example.com")]);
    serverMessages.set("Sent", [fetched(5, "Re: Invoice", "me@example.com")]);

    const result = await syncEmailAccount("acc-1");

    expect(result.errors).toEqual([]);
    // One existence lookup per folder, keyed by the UIDs the server returned.
    expect(vi.mocked(prisma.emailMessage.findMany).mock.calls).toEqual([
      [
        {
          where: { accountId: "acc-1", folder: "INBOX", uid: { in: ["5"] } },
          select: { uid: true, id: true },
        },
      ],
      [
        {
          where: { accountId: "acc-1", folder: "Sent", uid: { in: ["5"] } },
          select: { uid: true, id: true },
        },
      ],
    ]);
    expect(vi.mocked(prisma.emailMessage.createMany).mock.calls).toEqual([
      [
        {
          data: [
            expect.objectContaining({
              accountId: "acc-1",
              folder: "INBOX",
              uid: "5",
              subject: "Invoice",
            }),
          ],
        },
      ],
      [
        {
          data: [
            expect.objectContaining({
              accountId: "acc-1",
              folder: "Sent",
              uid: "5",
              subject: "Re: Invoice",
            }),
          ],
        },
      ],
    ]);
  });

  it("updates the row for the same folder and UID instead of creating a second one", async () => {
    serverMessages.set("INBOX", [fetched(5, "Invoice (edited)", "alice@example.com")]);
    vi.mocked(prisma.emailMessage.findMany).mockResolvedValue([{ id: "msg-1", uid: "5" }] as never);

    const result = await syncEmailAccount("acc-1");

    expect(vi.mocked(prisma.emailMessage.update).mock.calls).toEqual([
      [
        {
          where: { id: "msg-1" },
          data: expect.objectContaining({ folder: "INBOX", uid: "5", subject: "Invoice (edited)" }),
        },
      ],
    ]);
    expect(prisma.emailMessage.createMany).not.toHaveBeenCalled();
    expect(prisma.emailMessage.create).not.toHaveBeenCalled();
    expect(result).toMatchObject({ newMessages: 0, updatedMessages: 1 });
  });

  it("counts a message it has not stored before as new", async () => {
    serverMessages.set("INBOX", [
      fetched(5, "Invoice", "alice@example.com"),
      fetched(6, "Receipt", "billing@example.com"),
    ]);

    const result = await syncEmailAccount("acc-1");

    expect(result).toMatchObject({ newMessages: 2, updatedMessages: 0 });
    expect(prisma.emailMessage.createMany).toHaveBeenCalledTimes(1);
    const firstCall = vi.mocked(prisma.emailMessage.createMany).mock.calls[0] as unknown as [
      { data: unknown[] },
    ];
    expect(firstCall[0].data).toHaveLength(2);
  });

  it("flushes a big folder in batches instead of holding every envelope at once", async () => {
    // One past the batch size: the second flush carries the overflow.
    serverMessages.set(
      "INBOX",
      Array.from({ length: 2001 }, (_, i) => fetched(i + 1, `Message ${i + 1}`, "a@example.com")),
    );

    const result = await syncEmailAccount("acc-1");

    expect(result).toMatchObject({ newMessages: 2001, updatedMessages: 0 });
    expect(prisma.emailMessage.createMany).toHaveBeenCalledTimes(2);
    const sizes = vi
      .mocked(prisma.emailMessage.createMany)
      .mock.calls.map((call) => (call[0]!.data as unknown[]).length);
    expect(sizes).toEqual([2000, 1]);
  });

  it("keeps the batches already written when the fetch fails midway", async () => {
    // The iterator hands over a full batch and then errors, the way a dropped
    // IMAP connection does half-way through a big folder.
    serverMessages.set(
      "INBOX",
      Array.from({ length: 2001 }, (_, i) => fetched(i + 1, `Message ${i + 1}`, "a@example.com")),
    );
    fetchFailsAfter.set("INBOX", 2000);

    const result = await syncEmailAccount("acc-1");

    // The first batch is committed, the failure is reported for the folder.
    expect(prisma.emailMessage.createMany).toHaveBeenCalledTimes(1);
    expect(result.newMessages).toBe(2000);
    expect(result.errors).toEqual([expect.stringContaining("Failed to sync folder INBOX")]);
  });

  it("leaves the fetched body of an existing message alone", async () => {
    serverMessages.set("INBOX", [fetched(5, "Invoice", "alice@example.com")]);
    vi.mocked(prisma.emailMessage.findMany).mockResolvedValue([{ id: "msg-1", uid: "5" }] as never);

    await syncEmailAccount("acc-1");

    const data = vi.mocked(prisma.emailMessage.update).mock.calls[0]![0].data as object;
    expect(data).not.toHaveProperty("bodyText");
    expect(data).not.toHaveProperty("bodyHtml");
    expect(data).not.toHaveProperty("bodyPreview");
  });

  it("caches the discovered folders and special-use mapping on the account", async () => {
    mailboxList.push({
      path: "INBOX/Sent",
      name: "Sent",
      flags: new Set(["\\Sent"]),
      specialUse: "\\Sent",
    });
    serverMessages.set("INBOX/Sent", [fetched(1, "Sent note", "me@example.com")]);

    await syncEmailAccount("acc-1");

    const cached = vi
      .mocked(prisma.emailAccount.update)
      .mock.calls.find((call) => "cachedFolders" in (call[0].data as object));
    expect(cached?.[0]).toEqual({
      where: { id: "acc-1" },
      data: {
        cachedFolders: ["INBOX/Sent"],
        specialFolders: {
          "\\Sent": "INBOX/Sent",
          "\\Drafts": null,
          "\\Trash": null,
          "\\Archive": null,
        },
      },
    });
  });

  it("skips a folder the server says does not exist and keeps the rest", async () => {
    mailboxList.push({ path: "Junk", name: "Junk", flags: new Set<string>() });
    serverMessages.set("INBOX", [fetched(7, "Hello", "alice@example.com")]);
    folderErrors.set(
      "Junk",
      Object.assign(new Error("Mailbox doesn't exist"), {
        responseText: "Mailbox doesn't exist: Junk",
      }),
    );

    const { errors } = await syncEmailAccount("acc-1");

    expect(errors).toEqual([]);
    expect(prisma.emailMessage.createMany).toHaveBeenCalledTimes(1);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("reports a folder it could not sync without losing the others", async () => {
    mailboxList.push({ path: "Broken", name: "Broken", flags: new Set<string>() });
    serverMessages.set("INBOX", [fetched(7, "Hello", "alice@example.com")]);
    folderErrors.set("Broken", new Error("Invalid mailbox name"));

    const { errors, newMessages } = await syncEmailAccount("acc-1");

    expect(newMessages).toBe(1);
    expect(errors).toEqual(["Failed to sync folder Broken: Invalid mailbox name"]);
    expect(prisma.emailMessage.createMany).toHaveBeenCalledTimes(1);
  });
});
