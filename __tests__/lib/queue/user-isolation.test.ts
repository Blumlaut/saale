import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock Prisma — factory must be self-contained (hoisted to top of file)
vi.mock("@/lib/db", () => {
  const mockFn = vi.fn();
  return {
    prisma: {
      emailAccount: {
        findMany: mockFn,
      },
      calendarAccount: {
        findMany: mockFn,
      },
    },
  };
});

import { prisma } from "@/lib/db";
import {
  resolveUserEmailAccountIds,
  resolveUserCalendarAccountIds,
} from "@/lib/queue/user-isolation";

// Helper to cast mock return values to satisfy strict typing
// (mockFn returns `any` internally but TypeScript infers the full Prisma model type)
function mockAccounts(ids: string[]) {
  return ids.map((id) => ({ id })) as unknown as Awaited<
    ReturnType<typeof prisma.emailAccount.findMany>
  >;
}

function mockCalendarAccounts(ids: string[]) {
  return ids.map((id) => ({ id })) as unknown as Awaited<
    ReturnType<typeof prisma.calendarAccount.findMany>
  >;
}

describe("resolveUserEmailAccountIds", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns all enabled account IDs when no accountId specified", async () => {
    vi.mocked(prisma.emailAccount.findMany).mockResolvedValue(
      mockAccounts(["acc-1", "acc-2", "acc-3"]),
    );

    const ids = await resolveUserEmailAccountIds("user-1", undefined);

    expect(ids).toEqual(["acc-1", "acc-2", "acc-3"]);
    expect(prisma.emailAccount.findMany).toHaveBeenCalledWith({
      where: { userId: "user-1", enabled: true },
      select: { id: true },
    });
  });

  it("returns all IDs when accountId is empty string", async () => {
    vi.mocked(prisma.emailAccount.findMany).mockResolvedValue(mockAccounts(["acc-1"]));

    const ids = await resolveUserEmailAccountIds("user-1", "");

    expect(ids).toEqual(["acc-1"]);
  });

  it("returns IDs when specified accountId belongs to user", async () => {
    vi.mocked(prisma.emailAccount.findMany).mockResolvedValue(mockAccounts(["acc-1", "acc-2"]));

    const ids = await resolveUserEmailAccountIds("user-1", "acc-1");

    expect(ids).toEqual(["acc-1", "acc-2"]);
  });

  it("throws when specified accountId does not belong to user", async () => {
    vi.mocked(prisma.emailAccount.findMany).mockResolvedValue(mockAccounts(["acc-1"]));

    await expect(resolveUserEmailAccountIds("user-1", "acc-999")).rejects.toThrow(
      "Account acc-999 not found",
    );
  });

  it("returns empty array when user has no enabled accounts", async () => {
    vi.mocked(prisma.emailAccount.findMany).mockResolvedValue(mockAccounts([]));

    const ids = await resolveUserEmailAccountIds("user-1", undefined);

    expect(ids).toEqual([]);
  });

  it("queries with correct userId", async () => {
    vi.mocked(prisma.emailAccount.findMany).mockResolvedValue(mockAccounts([]));

    await resolveUserEmailAccountIds("user-42", undefined);

    expect(prisma.emailAccount.findMany).toHaveBeenCalledWith({
      where: { userId: "user-42", enabled: true },
      select: { id: true },
    });
  });
});

describe("resolveUserCalendarAccountIds", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns all enabled calendar account IDs", async () => {
    vi.mocked(prisma.calendarAccount.findMany).mockResolvedValue(
      mockCalendarAccounts(["cal-1", "cal-2"]),
    );

    const ids = await resolveUserCalendarAccountIds("user-1", undefined);

    expect(ids).toEqual(["cal-1", "cal-2"]);
  });

  it("throws when specified calendar account does not belong to user", async () => {
    vi.mocked(prisma.calendarAccount.findMany).mockResolvedValue(mockCalendarAccounts(["cal-1"]));

    await expect(resolveUserCalendarAccountIds("user-1", "cal-999")).rejects.toThrow(
      "Account cal-999 not found",
    );
  });
});
