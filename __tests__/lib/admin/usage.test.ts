import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The usage report's arithmetic: the ledger's rows become the window's totals,
 * a per-day series and one line per account, with our spend and theirs apart.
 */

const mocks = vi.hoisted(() => ({
  totals: vi.fn(),
  days: vi.fn(),
  users: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    $queryRaw: (query: TemplateStringsArray, ...values: unknown[]) => {
      const sql = query.join("?");
      return sql.includes("date_trunc") ? mocks.days(...values) : mocks.totals(...values);
    },
    user: { findMany: (...args: unknown[]) => mocks.users(...args) },
  },
}));

import { getUsageDetail, getUsageReport } from "@/lib/admin/usage";

/** One grouped ledger row, as the SQL returns it. */
function total(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    userId: "user-1",
    provider: "anthropic",
    scope: "global",
    kind: "chat",
    cost: 1,
    inputTokens: 1000,
    outputTokens: 200,
    calls: 3,
    billedCalls: 3,
    ...overrides,
  };
}

/** `YYYY-MM-DD` for a day offset from today. */
function day(offset: number): string {
  return new Date(Date.now() - offset * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.users.mockResolvedValue([
    { id: "user-1", name: "Ada", email: "ada@example.com", image: null },
    { id: "user-2", name: null, email: "grace@example.com", image: "/grace.png" },
  ]);
  mocks.totals.mockResolvedValue([]);
  mocks.days.mockResolvedValue([]);
});

describe("getUsageReport", () => {
  it("splits the window and every account by who paid", async () => {
    mocks.totals.mockResolvedValue([
      total({ userId: "user-1", scope: "global", cost: 3 }),
      total({ userId: "user-1", scope: "own", cost: 1, inputTokens: 500, calls: 1 }),
      total({ userId: "user-2", scope: "global", cost: 2, kind: "job", calls: 2 }),
    ]);

    const report = await getUsageReport(30);

    expect(report.rows.map((row) => row.userId)).toEqual(["user-1", "user-2"]);
    expect(report.rows[0]).toMatchObject({
      cost: 4,
      globalCost: 3,
      ownCost: 1,
      inputTokens: 1500,
      calls: 4,
    });
    expect(report).toMatchObject({ cost: 6, globalCost: 5, ownCost: 1, calls: 6 });
  });

  it("adds the window's spend up by kind, dearest first", async () => {
    mocks.totals.mockResolvedValue([
      total({ kind: "chat", cost: 1, calls: 2 }),
      total({ kind: "coder", cost: 4, scope: "own", calls: 5 }),
      total({ kind: "automation", cost: 2, calls: 1 }),
    ]);

    const report = await getUsageReport(7);

    expect(report.kinds.map((kind) => kind.kind)).toEqual(["coder", "automation", "chat"]);
    expect(report.kinds[0]).toMatchObject({ cost: 4, ownCost: 4, globalCost: 0, calls: 5 });
  });

  it("breaks an account's spend down by kind, dearest first", async () => {
    mocks.totals.mockResolvedValue([
      total({ kind: "chat", cost: 1 }),
      total({ kind: "coder", cost: 4 }),
      total({ kind: "automation", cost: 2 }),
    ]);

    const report = await getUsageReport(7);

    expect(report.rows[0]!.kinds).toEqual([
      { kind: "coder", cost: 4 },
      { kind: "automation", cost: 2 },
      { kind: "chat", cost: 1 },
    ]);
  });

  it("gives every day of the window a bar, quiet days at zero", async () => {
    mocks.days.mockResolvedValue([
      { date: day(2), scope: "global", cost: 5, calls: 4 },
      { date: day(0), scope: "own", cost: 1, calls: 1 },
    ]);

    const report = await getUsageReport(7);

    expect(report.daily).toHaveLength(7);
    expect(report.daily.at(-1)).toEqual({
      date: day(0),
      cost: 1,
      globalCost: 0,
      ownCost: 1,
      calls: 1,
    });
    expect(report.daily.some((entry) => entry.cost === 0)).toBe(true);
    expect(report.daily.at(-2)).toEqual({
      date: day(1),
      cost: 0,
      globalCost: 0,
      ownCost: 0,
      calls: 0,
    });
  });

  it("names an account by its email when it has no name", async () => {
    mocks.totals.mockResolvedValue([total({ userId: "user-2", cost: 2 })]);

    const report = await getUsageReport(30);

    expect(report.rows[0]).toMatchObject({ name: "grace@example.com", image: "/grace.png" });
  });

  it("reports whether any of the money is an estimate", async () => {
    mocks.totals.mockResolvedValue([total({ calls: 3, billedCalls: 3 })]);
    await expect(getUsageReport(30)).resolves.toMatchObject({ estimated: false });

    mocks.totals.mockResolvedValue([total({ calls: 3, billedCalls: 1 })]);
    await expect(getUsageReport(30)).resolves.toMatchObject({ estimated: true });
  });

  it("drops rows for a kind it does not know", async () => {
    mocks.totals.mockResolvedValue([total({ kind: "telepathy", cost: 9 })]);

    const report = await getUsageReport(30);

    expect(report.rows).toEqual([]);
    expect(report.kinds).toEqual([]);
    expect(report.cost).toBe(0);
  });
});

describe("getUsageDetail", () => {
  it("reads one account's kinds, providers and days", async () => {
    mocks.totals.mockResolvedValue([
      total({ provider: "anthropic", kind: "chat", cost: 2 }),
      total({ provider: "openai", kind: "chat", cost: 1, scope: "own" }),
      total({ provider: "openai", kind: "coder", cost: 4, calls: 6 }),
    ]);
    mocks.days.mockResolvedValue([{ date: day(1), scope: "global", cost: 7, calls: 9 }]);

    const detail = await getUsageDetail("user-1", 30);

    expect(detail).toMatchObject({ userId: "user-1", cost: 7, globalCost: 6, ownCost: 1 });
    expect(detail.kinds.map((kind) => [kind.kind, kind.cost])).toEqual([
      ["coder", 4],
      ["chat", 3],
    ]);
    expect(detail.providers).toEqual([
      { provider: "openai", cost: 5, calls: 9 },
      { provider: "anthropic", cost: 2, calls: 3 },
    ]);
    expect(detail.daily).toHaveLength(30);
    expect(detail.daily.at(-2)).toEqual({
      date: day(1),
      cost: 7,
      globalCost: 7,
      ownCost: 0,
      calls: 9,
    });
  });

  it("asks the ledger for that account only", async () => {
    await getUsageDetail("user-1", 7);

    expect(mocks.totals).toHaveBeenCalledWith(expect.any(Date), "user-1");
    expect(mocks.days).toHaveBeenCalledWith(expect.any(Date), "user-1");
  });
});
