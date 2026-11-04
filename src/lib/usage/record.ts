/**
 * The usage ledger's write side.
 *
 * Every model call costs someone: the workspace's provider keys, or the
 * account's own. One row per call keeps that answerable later, and `scope` is
 * what separates the two. The admin usage page adds the rows up; nothing else
 * reads them.
 *
 * Rows are narrow on purpose (a call is a few hundred bytes against the
 * kilobytes its own transcript already stores), and the indexes are on the two
 * ways the page asks: one account over a window, and everything over a window.
 */

import { prisma } from "@/lib/db";

/** What ran a model call. */
export const USAGE_KINDS = ["chat", "coder", "job", "automation", "email_draft"] as const;

export type UsageKind = (typeof USAGE_KINDS)[number];

/** Who pays for a call. */
export type UsageScope = "global" | "own";

export interface UsageRecord {
  userId: string;
  kind: UsageKind;
  provider: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheRead?: number;
  cacheWrite?: number;
  /** USD, as the provider billed it or the catalog estimated it. */
  cost?: number;
  billed?: boolean;
  /** The chat, job run or watcher the call belongs to. */
  refId?: string | null;
}

/** The totals Pi reports for a session, which is where a call's numbers come from. */
export interface SessionStatsLike {
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  cost: number;
}

/** The ledger row for a session that ran one prompt, from its own totals. */
export function usageFromSession(
  stats: SessionStatsLike,
  base: { userId: string; kind: UsageKind; provider: string; model: string; refId?: string | null },
): UsageRecord {
  return {
    ...base,
    inputTokens: stats.tokens.input,
    outputTokens: stats.tokens.output,
    cacheRead: stats.tokens.cacheRead,
    cacheWrite: stats.tokens.cacheWrite,
    cost: stats.cost,
  };
}

/**
 * What kind of work a chat's spend belongs to.
 *
 * A chat a watcher opened is an automation's cost however it is delivered; a
 * chat with a project is code work; everything else is a conversation.
 */
export function chatUsageKind(chat: { projectId: string | null; origin: string }): UsageKind {
  if (chat.origin === "watcher") return "automation";
  return chat.projectId ? "coder" : "chat";
}

/**
 * Whether a call on this provider bills the account's own key or the
 * workspace's.
 *
 * A user runtime reads its own credential and otherwise inherits the global
 * one, so the account holding a row for this provider is what decides it.
 */
export async function providerScope(userId: string, provider: string): Promise<UsageScope> {
  const own = await prisma.providerApiKey.findUnique({
    where: { userId_provider: { userId, provider } },
    select: { id: true },
  });
  return own ? "own" : "global";
}

/**
 * Add one model call to the ledger.
 *
 * Never throws: accounting must not fail the call it is counting. A failed
 * write is logged and dropped. A call that spent nothing writes no row, so a
 * turn that failed before its first token leaves no clutter behind.
 */
export async function recordUsage(record: UsageRecord): Promise<void> {
  const spent =
    (record.inputTokens ?? 0) +
    (record.outputTokens ?? 0) +
    (record.cacheRead ?? 0) +
    (record.cacheWrite ?? 0) +
    (record.cost ?? 0);
  if (spent === 0) return;

  try {
    const scope = await providerScope(record.userId, record.provider);
    await prisma.usageEvent.create({
      data: {
        userId: record.userId,
        kind: record.kind,
        provider: record.provider,
        model: record.model,
        scope,
        inputTokens: record.inputTokens ?? 0,
        outputTokens: record.outputTokens ?? 0,
        cacheRead: record.cacheRead ?? 0,
        cacheWrite: record.cacheWrite ?? 0,
        cost: record.cost ?? 0,
        billed: record.billed ?? false,
        refId: record.refId ?? null,
      },
    });
  } catch (err) {
    console.error(`Failed to record ${record.kind} usage for ${record.userId}:`, err);
  }
}
