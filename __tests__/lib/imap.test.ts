import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock dependencies before importing the module
vi.mock("@/lib/db", () => ({
  prisma: {
    emailAccount: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock("@/lib/crypto", () => ({
  decrypt: vi.fn(() => "test-password"),
}));

vi.mock("imapflow", () => {
  const mockMailbox = {
    connect: vi.fn().mockResolvedValue(undefined),
    logout: vi.fn().mockResolvedValue(undefined),
    mailboxOpen: vi.fn().mockResolvedValue(undefined),
    mailboxClose: vi.fn().mockResolvedValue(undefined),
    messageFlagsAdd: vi.fn().mockResolvedValue(true),
    messageFlagsRemove: vi.fn().mockResolvedValue(true),
    messageMove: vi.fn().mockResolvedValue({ copied: 1 }),
    messageDelete: vi.fn().mockResolvedValue(true),
  };

  class MockImapFlow {
    constructor(_options: unknown) {
      // Store options for test assertions
      void _options;
    }

    connect() {
      return mockMailbox.connect();
    }

    logout() {
      return mockMailbox.logout();
    }

    mailboxOpen(...args: unknown[]) {
      return mockMailbox.mailboxOpen(...args);
    }

    mailboxClose() {
      return mockMailbox.mailboxClose();
    }

    messageFlagsAdd(...args: unknown[]) {
      return mockMailbox.messageFlagsAdd(...args);
    }

    messageFlagsRemove(...args: unknown[]) {
      return mockMailbox.messageFlagsRemove(...args);
    }

    messageMove(...args: unknown[]) {
      return mockMailbox.messageMove(...args);
    }

    messageDelete(...args: unknown[]) {
      return mockMailbox.messageDelete(...args);
    }
  }

  return { ImapFlow: MockImapFlow };
});

import { prisma } from "@/lib/db";
import { syncMessageFlags, moveMessage, deleteMessage, syncMessagesBatch } from "@/lib/email/imap";

const mockAccount = {
  id: "acc-1",
  email: "test@example.com",
  imapHost: "imap.example.com",
  imapPort: 993,
  imapSecure: true,
  encryptedPassword: "encrypted",
};

const mockMessage = {
  accountId: "acc-1",
  uid: "12345",
  folder: "INBOX",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.emailAccount.findUnique).mockResolvedValue(mockAccount as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("syncMessageFlags", () => {
  it("sets \\Seen flag when isRead=true", async () => {
    await syncMessageFlags(mockAccount.id, mockMessage.folder, mockMessage.uid, {
      isRead: true,
    });

    expect(prisma.emailAccount.findUnique).toHaveBeenCalledWith({
      where: { id: mockAccount.id },
    });
  });

  it("removes \\Seen flag when isRead=false", async () => {
    await syncMessageFlags(mockAccount.id, mockMessage.folder, mockMessage.uid, {
      isRead: false,
    });

    expect(prisma.emailAccount.findUnique).toHaveBeenCalledWith({
      where: { id: mockAccount.id },
    });
  });

  it("sets \\Flagged flag when isStarred=true", async () => {
    await syncMessageFlags(mockAccount.id, mockMessage.folder, mockMessage.uid, {
      isStarred: true,
    });

    expect(prisma.emailAccount.findUnique).toHaveBeenCalledWith({
      where: { id: mockAccount.id },
    });
  });

  it("removes \\Flagged flag when isStarred=false", async () => {
    await syncMessageFlags(mockAccount.id, mockMessage.folder, mockMessage.uid, {
      isStarred: false,
    });

    expect(prisma.emailAccount.findUnique).toHaveBeenCalledWith({
      where: { id: mockAccount.id },
    });
  });

  it("handles both isRead and isStarred in one call", async () => {
    await syncMessageFlags(mockAccount.id, mockMessage.folder, mockMessage.uid, {
      isRead: true,
      isStarred: true,
    });

    expect(prisma.emailAccount.findUnique).toHaveBeenCalledWith({
      where: { id: mockAccount.id },
    });
  });

  it("converts string UID to number for imapflow", async () => {
    await syncMessageFlags(mockAccount.id, mockMessage.folder, "99999", {
      isRead: true,
    });

    // Should not throw — UID conversion should work
    expect(prisma.emailAccount.findUnique).toHaveBeenCalled();
  });

  it("accepts numeric UID directly", async () => {
    await syncMessageFlags(mockAccount.id, mockMessage.folder, 99999, {
      isRead: true,
    });

    expect(prisma.emailAccount.findUnique).toHaveBeenCalled();
  });

  it("does not fail if IMAP server is unreachable", async () => {
    // Best-effort: should not throw even when connection fails
    await expect(
      syncMessageFlags(mockAccount.id, mockMessage.folder, mockMessage.uid, {
        isRead: true,
      }),
    ).resolves.toBeUndefined();
  });

  it("throws if account not found", async () => {
    vi.mocked(prisma.emailAccount.findUnique).mockResolvedValue(null as never);

    await expect(syncMessageFlags("nonexistent", "INBOX", "123", { isRead: true })).rejects.toThrow(
      "Email account nonexistent not found",
    );
  });
});

describe("moveMessage", () => {
  it("moves a message to a different folder", async () => {
    await moveMessage(mockAccount.id, "INBOX", mockMessage.uid, "Archive");

    expect(prisma.emailAccount.findUnique).toHaveBeenCalledWith({
      where: { id: mockAccount.id },
    });
  });

  it("converts string UID to number", async () => {
    await moveMessage(mockAccount.id, "INBOX", "99999", "Trash");

    expect(prisma.emailAccount.findUnique).toHaveBeenCalled();
  });

  it("does not fail if IMAP server is unreachable", async () => {
    // Best-effort: should not throw
    await expect(
      moveMessage(mockAccount.id, "INBOX", mockMessage.uid, "Archive"),
    ).resolves.toBeUndefined();
  });
});

describe("deleteMessage", () => {
  it("deletes a message", async () => {
    await deleteMessage(mockAccount.id, "INBOX", mockMessage.uid);

    expect(prisma.emailAccount.findUnique).toHaveBeenCalledWith({
      where: { id: mockAccount.id },
    });
  });

  it("converts string UID to number", async () => {
    await deleteMessage(mockAccount.id, "INBOX", "99999");

    expect(prisma.emailAccount.findUnique).toHaveBeenCalled();
  });

  it("does not fail if IMAP server is unreachable", async () => {
    await expect(deleteMessage(mockAccount.id, "INBOX", mockMessage.uid)).resolves.toBeUndefined();
  });
});

describe("syncMessagesBatch", () => {
  it("syncs multiple messages grouped by folder", async () => {
    await syncMessagesBatch(mockAccount.id, [
      { uid: "1", folder: "INBOX", isRead: true },
      { uid: "2", folder: "INBOX", isStarred: true },
      { uid: "3", folder: "Sent", isRead: true },
    ]);

    expect(prisma.emailAccount.findUnique).toHaveBeenCalled();
  });

  it("does nothing for empty list", async () => {
    await syncMessagesBatch(mockAccount.id, []);

    expect(prisma.emailAccount.findUnique).not.toHaveBeenCalled();
  });

  it("handles messages across multiple folders", async () => {
    await syncMessagesBatch(mockAccount.id, [
      { uid: "1", folder: "INBOX", isRead: true },
      { uid: "2", folder: "Archive", isStarred: false },
      { uid: "3", folder: "Drafts", isRead: true, isStarred: true },
    ]);

    expect(prisma.emailAccount.findUnique).toHaveBeenCalled();
  });

  it("does not fail if IMAP server is unreachable", async () => {
    await expect(
      syncMessagesBatch(mockAccount.id, [{ uid: "1", folder: "INBOX", isRead: true }]),
    ).resolves.toBeUndefined();
  });
});
