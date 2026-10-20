import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    emailAccount: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock("@/lib/crypto", () => ({
  decrypt: vi.fn(() => "test-password"),
}));

const mockConnect = vi.fn();

vi.mock("imapflow", () => {
  class MockImapFlow {
    connect() {
      return mockConnect();
    }
    logout() {
      return Promise.resolve();
    }
    list() {
      return Promise.resolve([]);
    }
    mailboxOpen() {
      return Promise.resolve();
    }
    mailboxClose() {
      return Promise.resolve();
    }
    search() {
      return Promise.resolve([]);
    }
  }
  return { ImapFlow: MockImapFlow };
});

import { prisma } from "@/lib/db";
import { syncEmailAccount } from "@/lib/email/sync";

const ACCOUNT = {
  id: "acc-1",
  userId: "user-1",
  email: "esthrw1@proton.me",
  imapHost: "imap.gmail.com",
  imapPort: 993,
  imapSecure: true,
  smtpHost: "smtp.gmail.com",
  smtpPort: 465,
  smtpSecure: true,
  encryptedPassword: "encrypted",
  enabled: true,
  lastSyncedAt: null,
};

/** The update call that carries the sync outcome, if there is one. */
function outcomeUpdate() {
  return vi
    .mocked(prisma.emailAccount.update)
    .mock.calls.map(([args]) => args)
    .find((args) => "lastSyncError" in (args as { data: Record<string, unknown> }).data);
}

describe("syncEmailAccount outcome recording", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConnect.mockReset();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(prisma.emailAccount.findUnique).mockResolvedValue(ACCOUNT as never);
    vi.mocked(prisma.emailAccount.update).mockResolvedValue(ACCOUNT as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("records why a failed sync failed, so the account does not look merely empty", async () => {
    mockConnect.mockRejectedValue(
      new Error("Invalid login: 535 5.7.8 Username and Password not accepted"),
    );

    const result = await syncEmailAccount("acc-1");

    expect(result.errors).toHaveLength(1);
    expect(outcomeUpdate()).toMatchObject({
      where: { id: "acc-1" },
      data: {
        lastSyncError: expect.stringContaining("Invalid login: 535 5.7.8"),
        lastSyncErrorAt: expect.any(Date),
      },
    });
    // lastSyncedAt stays untouched  nothing was synced.
    expect(
      vi
        .mocked(prisma.emailAccount.update)
        .mock.calls.map(([args]) => args)
        .some((args) => "lastSyncedAt" in (args as { data: Record<string, unknown> }).data),
    ).toBe(false);
  });

  it("clears the recorded failure once a sync succeeds", async () => {
    mockConnect.mockResolvedValue(undefined);

    const result = await syncEmailAccount("acc-1");

    expect(result.errors).toEqual([]);
    expect(outcomeUpdate()).toMatchObject({
      where: { id: "acc-1" },
      data: { lastSyncError: null, lastSyncErrorAt: null },
    });
  });

  it("does not fail the sync when the outcome cannot be persisted", async () => {
    mockConnect.mockRejectedValue(new Error("Connection error"));
    vi.mocked(prisma.emailAccount.update).mockRejectedValue(new Error("db down"));

    const result = await syncEmailAccount("acc-1");

    expect(result.errors).toHaveLength(1);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("Failed to record sync outcome"),
      expect.any(Error),
    );
  });
});
