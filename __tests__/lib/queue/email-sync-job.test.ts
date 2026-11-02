import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/email/sync", () => ({ syncEmailAccount: vi.fn() }));
vi.mock("@/lib/redis", () => ({ claimEmailSync: vi.fn(), releaseEmailSync: vi.fn() }));
vi.mock("@/lib/queue/user-isolation", () => ({ resolveUserEmailAccountIds: vi.fn() }));

import { syncEmailAccount } from "@/lib/email/sync";
import { claimEmailSync, releaseEmailSync } from "@/lib/redis";
import { resolveUserEmailAccountIds } from "@/lib/queue/user-isolation";
import { handler } from "@/lib/queue/jobs/email-sync";

const mockSync = vi.mocked(syncEmailAccount);
const mockClaim = vi.mocked(claimEmailSync);
const mockRelease = vi.mocked(releaseEmailSync);
const mockResolve = vi.mocked(resolveUserEmailAccountIds);

const synced = { newMessages: 2, updatedMessages: 1, errors: [] };

/** The handler's output, parsed back out of its JSON string. */
async function runOverAllAccounts(): Promise<{
  accounts: number;
  results: Array<Record<string, unknown>>;
}> {
  const output = await handler({ config: {}, userId: "user-1" });
  return JSON.parse(output);
}

describe("email_sync job", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClaim.mockResolvedValue(true);
    mockRelease.mockResolvedValue(undefined);
    mockSync.mockResolvedValue(synced);
  });

  it("syncs every enabled account and releases each claim", async () => {
    mockResolve.mockResolvedValue(["acc-1", "acc-2"]);

    const output = await runOverAllAccounts();

    expect(mockSync).toHaveBeenCalledTimes(2);
    expect(mockSync).toHaveBeenNthCalledWith(1, "acc-1");
    expect(mockSync).toHaveBeenNthCalledWith(2, "acc-2");
    expect(mockRelease).toHaveBeenCalledWith("acc-1");
    expect(mockRelease).toHaveBeenCalledWith("acc-2");
    expect(output).toEqual({ accounts: 2, results: [synced, synced] });
  });

  it("leaves an account alone while another sync holds it", async () => {
    mockResolve.mockResolvedValue(["acc-1", "acc-2"]);
    mockClaim.mockImplementation(async (accountId) => accountId === "acc-2");

    const output = await runOverAllAccounts();

    expect(mockSync).toHaveBeenCalledTimes(1);
    expect(mockSync).toHaveBeenCalledWith("acc-2");
    expect(mockRelease).toHaveBeenCalledTimes(1);
    expect(mockRelease).toHaveBeenCalledWith("acc-2");
    expect(output.results[0]).toEqual({
      newMessages: 0,
      updatedMessages: 0,
      errors: [],
      skipped: "Another sync is already running for this account",
    });
  });

  it("syncs the selected account only", async () => {
    mockResolve.mockResolvedValue(["acc-1"]);

    const output = await handler({ config: { accountId: "acc-1" }, userId: "user-1" });

    expect(mockResolve).toHaveBeenCalledWith("user-1", "acc-1");
    expect(mockSync).toHaveBeenCalledWith("acc-1");
    expect(JSON.parse(output)).toEqual(synced);
  });

  it("fails when the selected account is not an enabled account of the user", async () => {
    mockResolve.mockResolvedValue([]);

    await expect(handler({ config: { accountId: "acc-x" }, userId: "user-1" })).rejects.toThrow(
      "Email account acc-x not found or disabled",
    );
    expect(mockSync).not.toHaveBeenCalled();
  });

  it("releases the claim when the sync throws", async () => {
    mockResolve.mockResolvedValue(["acc-1"]);
    mockSync.mockRejectedValue(new Error("imap down"));

    await expect(runOverAllAccounts()).rejects.toThrow("imap down");
    expect(mockRelease).toHaveBeenCalledWith("acc-1");
  });
});
