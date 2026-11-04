/**
 * What the usage page shows: the window's spend by type, by day, and by account.
 *
 * The ledger holds a row per model call. Two `GROUP BY` queries read the window
 * once (per account, provider, scope and kind; and per day), and the page adds
 * them up. An account's own detail is read only when its row is unfolded, so the
 * list stays one payload however many accounts there are.
 */

import { prisma } from "@/lib/db";
import type { UsageKind } from "@/lib/usage/record";
import type { UsageWindow } from "@/lib/admin/usage-windows";

/** Money and tokens over a window. */
export interface UsageTotals {
  /** USD, all calls. */
  cost: number;
  /** USD billed to the workspace's provider keys. */
  globalCost: number;
  /** USD billed to the account's own provider keys. */
  ownCost: number;
  inputTokens: number;
  outputTokens: number;
  /** Calls the ledger counted. */
  calls: number;
}

/** One kind of work, with the same split. */
export interface UsageKindTotals extends UsageTotals {
  kind: UsageKind;
}

/** One day of the window. */
export interface UsageDay {
  /** `YYYY-MM-DD`. */
  date: string;
  cost: number;
  globalCost: number;
  ownCost: number;
  calls: number;
}

/** One account, as its collapsed row shows it. */
export interface UsageRow extends UsageTotals {
  userId: string;
  name: string;
  email: string;
  image: string | null;
  /** Cost per kind, dearest first. */
  kinds: Array<{ kind: UsageKind; cost: number }>;
}

export interface UsageReport extends UsageTotals {
  days: UsageWindow;
  since: string;
  /** Every kind used in the window, dearest first. */
  kinds: UsageKindTotals[];
  /** One entry per day of the window, oldest first, empty days included. */
  daily: UsageDay[];
  rows: UsageRow[];
  /** True when some of the money is a catalog estimate rather than a bill. */
  estimated: boolean;
}

/** One account's own detail, read when its row is unfolded. */
export interface UsageDetail extends UsageTotals {
  userId: string;
  days: UsageWindow;
  kinds: UsageKindTotals[];
  providers: Array<{ provider: string; cost: number; calls: number }>;
  daily: UsageDay[];
}

interface GroupedRow {
  userId: string;
  provider: string;
  scope: string;
  kind: string;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  calls: number;
  billedCalls: number;
}

interface DayRow {
  date: string;
  scope: string;
  cost: number;
  calls: number;
}

const KINDS: readonly UsageKind[] = ["chat", "coder", "job", "automation", "email_draft"];

function isKind(value: string): value is UsageKind {
  return (KINDS as readonly string[]).includes(value);
}

function emptyTotals(): UsageTotals {
  return { cost: 0, globalCost: 0, ownCost: 0, inputTokens: 0, outputTokens: 0, calls: 0 };
}

function addRow(target: UsageTotals, row: GroupedRow): void {
  target.cost += Number(row.cost);
  if (row.scope === "own") target.ownCost += Number(row.cost);
  else target.globalCost += Number(row.cost);
  target.inputTokens += Number(row.inputTokens);
  target.outputTokens += Number(row.outputTokens);
  target.calls += Number(row.calls);
}

/** Midnight of the first day of the window, so its bars end on today. */
function startOf(days: UsageWindow): Date {
  const midnight = new Date();
  midnight.setUTCHours(0, 0, 0, 0);
  return new Date(midnight.getTime() - (days - 1) * 24 * 60 * 60 * 1000);
}

/** Every day of the window, so a quiet day reads as zero instead of vanishing. */
function fillDays(days: UsageWindow, rows: readonly DayRow[]): UsageDay[] {
  const byDate = new Map<string, UsageDay>();
  for (const row of rows) {
    const day = byDate.get(row.date) ?? {
      date: row.date,
      cost: 0,
      globalCost: 0,
      ownCost: 0,
      calls: 0,
    };
    const cost = Number(row.cost);
    day.cost += cost;
    if (row.scope === "own") day.ownCost += cost;
    else day.globalCost += cost;
    day.calls += Number(row.calls);
    byDate.set(row.date, day);
  }

  const series: UsageDay[] = [];
  const start = startOf(days);
  for (let index = 0; index < days; index += 1) {
    const at = new Date(start.getTime() + index * 24 * 60 * 60 * 1000);
    const date = at.toISOString().slice(0, 10);
    series.push(byDate.get(date) ?? { date, cost: 0, globalCost: 0, ownCost: 0, calls: 0 });
  }
  return series;
}

function kindTotals(byKind: Map<UsageKind, UsageKindTotals>): UsageKindTotals[] {
  return [...byKind.values()].sort((a, b) => b.cost - a.cost || a.kind.localeCompare(b.kind));
}

function emptyKind(kind: UsageKind): UsageKindTotals {
  return { kind, ...emptyTotals() };
}

/** Every account's spend over the window, dearest first. */
export async function getUsageReport(days: UsageWindow): Promise<UsageReport> {
  const since = startOf(days);

  const [grouped, dayRows, users] = await Promise.all([
    prisma.$queryRaw<GroupedRow[]>`
      SELECT "userId",
             "provider",
             "scope",
             "kind",
             sum("cost")::float8        AS "cost",
             sum("inputTokens")::float8  AS "inputTokens",
             sum("outputTokens")::float8 AS "outputTokens",
             count(*)::int              AS "calls",
             (count(*) FILTER (WHERE "billed"))::int AS "billedCalls"
      FROM "UsageEvent"
      WHERE "createdAt" >= ${since}
      GROUP BY "userId", "provider", "scope", "kind"
    `,
    prisma.$queryRaw<DayRow[]>`
      SELECT to_char(date_trunc('day', "createdAt"), 'YYYY-MM-DD') AS "date",
             "scope",
             sum("cost")::float8 AS "cost",
             count(*)::int       AS "calls"
      FROM "UsageEvent"
      WHERE "createdAt" >= ${since}
      GROUP BY 1, 2
      ORDER BY 1
    `,
    prisma.user.findMany({ select: { id: true, name: true, email: true, image: true } }),
  ]);

  const usersById = new Map(users.map((user) => [user.id, user]));
  const total = emptyTotals();
  const byKind = new Map<UsageKind, UsageKindTotals>();
  const byUser = new Map<string, UsageRow>();
  const userKinds = new Map<string, Map<UsageKind, number>>();
  let calls = 0;
  let billedCalls = 0;

  for (const row of grouped) {
    if (!isKind(row.kind)) continue;
    const cost = Number(row.cost);
    calls += Number(row.calls);
    billedCalls += Number(row.billedCalls);
    addRow(total, row);

    const kind = byKind.get(row.kind) ?? emptyKind(row.kind);
    addRow(kind, row);
    byKind.set(row.kind, kind);

    const user = usersById.get(row.userId);
    const account = byUser.get(row.userId) ?? {
      userId: row.userId,
      name: user?.name ?? user?.email ?? row.userId,
      email: user?.email ?? "",
      image: user?.image ?? null,
      kinds: [],
      ...emptyTotals(),
    };
    addRow(account, row);
    byUser.set(row.userId, account);

    const kinds = userKinds.get(row.userId) ?? new Map<UsageKind, number>();
    kinds.set(row.kind, (kinds.get(row.kind) ?? 0) + cost);
    userKinds.set(row.userId, kinds);
  }

  for (const [userId, kinds] of userKinds) {
    const account = byUser.get(userId);
    if (!account) continue;
    account.kinds = [...kinds]
      .map(([kind, cost]) => ({ kind, cost }))
      .sort((a, b) => b.cost - a.cost || a.kind.localeCompare(b.kind));
  }

  return {
    ...total,
    days,
    since: since.toISOString(),
    kinds: kindTotals(byKind),
    daily: fillDays(days, dayRows),
    rows: [...byUser.values()].sort((a, b) => b.cost - a.cost || a.name.localeCompare(b.name)),
    estimated: billedCalls < calls,
  };
}

/** One account's spend over the window: by kind, by provider, and by day. */
export async function getUsageDetail(userId: string, days: UsageWindow): Promise<UsageDetail> {
  const since = startOf(days);

  const [grouped, dayRows] = await Promise.all([
    prisma.$queryRaw<GroupedRow[]>`
      SELECT "userId",
             "provider",
             "scope",
             "kind",
             sum("cost")::float8        AS "cost",
             sum("inputTokens")::float8  AS "inputTokens",
             sum("outputTokens")::float8 AS "outputTokens",
             count(*)::int              AS "calls",
             (count(*) FILTER (WHERE "billed"))::int AS "billedCalls"
      FROM "UsageEvent"
      WHERE "createdAt" >= ${since} AND "userId" = ${userId}
      GROUP BY "userId", "provider", "scope", "kind"
    `,
    prisma.$queryRaw<DayRow[]>`
      SELECT to_char(date_trunc('day', "createdAt"), 'YYYY-MM-DD') AS "date",
             "scope",
             sum("cost")::float8 AS "cost",
             count(*)::int       AS "calls"
      FROM "UsageEvent"
      WHERE "createdAt" >= ${since} AND "userId" = ${userId}
      GROUP BY 1, 2
      ORDER BY 1
    `,
  ]);

  const total = emptyTotals();
  const byKind = new Map<UsageKind, UsageKindTotals>();
  const byProvider = new Map<string, { provider: string; cost: number; calls: number }>();

  for (const row of grouped) {
    if (!isKind(row.kind)) continue;
    addRow(total, row);

    const kind = byKind.get(row.kind) ?? emptyKind(row.kind);
    addRow(kind, row);
    byKind.set(row.kind, kind);

    const provider = byProvider.get(row.provider) ?? { provider: row.provider, cost: 0, calls: 0 };
    provider.cost += Number(row.cost);
    provider.calls += Number(row.calls);
    byProvider.set(row.provider, provider);
  }

  return {
    ...total,
    userId,
    days,
    kinds: kindTotals(byKind),
    providers: [...byProvider.values()].sort((a, b) => b.cost - a.cost || b.calls - a.calls),
    daily: fillDays(days, dayRows),
  };
}
