/**
 * One watcher tick, end to end: check the grant, run the script, decide whether
 * the result is worth waking the agent for, and record what happened.
 *
 * The decision to spend tokens belongs here rather than in the script. A script
 * that could say "wake the agent" on every tick would be an unbounded spend
 * channel; a script that reports what it found, with the definition owning the
 * cooldown and the ledger, keeps the bound in the place the user configured.
 */

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { loadWatcherToolAccess } from "./access";
import { checkGrant } from "./grant";
import { applyStoreWrites, isFiring, runWatcherScript } from "./runner";
import { wakeAgent } from "./wake";

/** Ticks kept per watcher. Older rows are pruned after each tick. */
export const TICK_HISTORY_LIMIT = 50;

/** What one tick concluded. */
export type TickStatus = "idle" | "fired" | "cooldown" | "blocked" | "error";

export interface TickOutcome {
  status: TickStatus;
  /** The script's return value, when it returned one. */
  value?: unknown;
  /** Why the tick did not fire, or the failure, when the status alone does not say. */
  reason?: string;
  output: string;
  durationMs: number;
  callCount: number;
}

/** The watcher a tick runs for. */
type WatcherRow = Prisma.ScriptWatcherGetPayload<Record<string, never>>;

/** Reading a script's result: what it produced, and whether it is a report. */
interface Evaluation {
  watcher: WatcherRow;
  outcome: TickOutcome;
  /** The store as it would stand after this run. */
  nextStore: Record<string, unknown>;
  /** True when the script reported something — the wake decision is separate. */
  firing: boolean;
}

/** The store, as the JSON column holds it. */
function readStore(value: Prisma.JsonValue): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

/** JSON-encode a value for the tick log, without letting a bad value fail the tick. */
function encodeValue(value: unknown): string | null {
  if (value === undefined) return null;
  try {
    return JSON.stringify(value) ?? null;
  } catch (err) {
    console.error("Failed to encode watcher tick value:", err);
    return null;
  }
}

/**
 * Check the grant, run the script, and read what came back.
 *
 * Writes nothing and wakes nobody: this is the whole of a tick's judgement, and
 * the caller decides whether to act on it (a scheduled tick does; a preview does
 * not).
 */
async function evaluate(watcher: WatcherRow): Promise<Evaluation> {
  const scopeId = watcher.sessionId ?? `watcher:${watcher.id}`;
  const { callable, callableNames, toolPolicies } = await loadWatcherToolAccess(
    watcher.userId,
    scopeId,
  );

  const base = { output: "", durationMs: 0, callCount: 0 };
  const store = readStore(watcher.store);
  const empty = { ...store };

  // ── The grant ───────────────────────────────────────────────────────
  const violation = checkGrant({
    grant: {
      script: watcher.script,
      scriptHash: watcher.scriptHash,
      grantedTools: watcher.grantedTools,
      grantAll: watcher.grantAll,
    },
    callableNames,
    toolPolicies,
  });

  if (violation) {
    return {
      watcher,
      outcome: {
        ...base,
        status: "blocked",
        reason: [violation.reason, violation.missing.join(", ")].filter(Boolean).join(" "),
      },
      nextStore: empty,
      firing: false,
    };
  }

  // ── The script ──────────────────────────────────────────────────────
  const result = await runWatcherScript({ script: watcher.script, tools: callable, store });

  const measured = {
    output: result.output,
    durationMs: result.durationMs,
    callCount: result.callCount,
  };

  if (!result.ok) {
    return {
      watcher,
      outcome: { ...measured, status: "error", reason: result.error ?? "Script failed" },
      nextStore: empty,
      firing: false,
    };
  }

  const nextStore = applyStoreWrites(store, result.storeWrites);

  // Nothing to report — the common case, and the reason a tick is cheap.
  if (!isFiring(result.value)) {
    return {
      watcher,
      outcome: { ...measured, status: "idle", value: result.value },
      nextStore,
      firing: false,
    };
  }

  return {
    watcher,
    outcome: { ...measured, status: "fired", value: result.value },
    nextStore,
    firing: true,
  };
}

/**
 * Record a tick and advance the watcher's counters.
 *
 * `store` is passed only when the tick's work is finished with the state it
 * read. A tick that intended to wake the agent but could not leaves the store
 * alone, so the script re-derives the same fire next time instead of the ledger
 * moving past a report the user never received.
 */
async function recordTick(options: {
  watcherId: string;
  outcome: TickOutcome;
  store?: Record<string, unknown>;
  advanceStore: boolean;
  fired: boolean;
}): Promise<TickOutcome> {
  const { outcome } = options;

  await prisma.scriptWatcherTick.create({
    data: {
      watcherId: options.watcherId,
      status: outcome.status,
      value: encodeValue(outcome.value),
      error: outcome.reason ?? null,
      output: outcome.output ? outcome.output.slice(0, 20_000) : null,
      durationMs: outcome.durationMs,
      callCount: outcome.callCount,
    },
  });

  await prisma.scriptWatcher.update({
    where: { id: options.watcherId },
    data: {
      tickCount: { increment: 1 },
      lastTickAt: new Date(),
      lastValue: encodeValue(outcome.value),
      lastError:
        outcome.status === "error" || outcome.status === "blocked"
          ? (outcome.reason ?? null)
          : null,
      ...(options.advanceStore && options.store !== undefined
        ? { store: options.store as Prisma.InputJsonValue }
        : {}),
      ...(options.fired ? { fireCount: { increment: 1 }, lastFiredAt: new Date() } : {}),
    },
  });

  await pruneTicks(options.watcherId).catch((err) => {
    console.error(`Failed to prune ticks for watcher ${options.watcherId}:`, err);
  });

  return outcome;
}

/** Drop all but the most recent {@link TICK_HISTORY_LIMIT} ticks. */
async function pruneTicks(watcherId: string): Promise<void> {
  const keep = await prisma.scriptWatcherTick.findMany({
    where: { watcherId },
    orderBy: { createdAt: "desc" },
    take: TICK_HISTORY_LIMIT,
    select: { id: true },
  });

  if (keep.length < TICK_HISTORY_LIMIT) return;

  await prisma.scriptWatcherTick.deleteMany({
    where: { watcherId, id: { notIn: keep.map((tick) => tick.id) } },
  });
}

/**
 * Run one tick for a watcher.
 *
 * Never throws: every outcome — including a script that failed, a grant that no
 * longer holds, and a wake that could not be delivered — is a tick the log has
 * to show, so each one is recorded and returned.
 */
export async function runWatcherTick(watcherId: string): Promise<TickOutcome> {
  const watcher = await prisma.scriptWatcher.findUnique({ where: { id: watcherId } });

  if (!watcher || !watcher.enabled) {
    // The scheduler is removed by the caller for a disabled watcher; a tick that
    // still arrives gets no row, so a removed watcher cannot grow a log.
    return {
      status: "blocked",
      reason: watcher ? "Watcher is disabled" : "Watcher not found",
      output: "",
      durationMs: 0,
      callCount: 0,
    };
  }

  const evaluation = await evaluate(watcher);
  const { outcome } = evaluation;

  if (!evaluation.firing) {
    return recordTick({
      watcherId: watcher.id,
      outcome,
      // A blocked tick records that it was blocked — a watcher that keeps
      // refusing to run is exactly what the log is for — but moves no ledger.
      store: evaluation.nextStore,
      advanceStore: outcome.status !== "blocked",
      fired: false,
    });
  }

  // ── The cooldown ────────────────────────────────────────────────────
  // A deliberate drop: the change was real, but the user asked not to be told
  // more often than this, so the script's ledger moves on with it.
  if (watcher.cooldownMinutes > 0 && watcher.lastFiredAt) {
    const readyAt = new Date(watcher.lastFiredAt.getTime() + watcher.cooldownMinutes * 60_000);
    if (readyAt > new Date()) {
      return recordTick({
        watcherId: watcher.id,
        outcome: {
          ...outcome,
          status: "cooldown",
          reason: `Cooling down until ${readyAt.toISOString()}`,
        },
        store: evaluation.nextStore,
        advanceStore: true,
        fired: false,
      });
    }
  }

  // ── The wake ────────────────────────────────────────────────────────
  try {
    await wakeAgent({
      userId: watcher.userId,
      name: watcher.name,
      wakePrompt: watcher.wakePrompt,
      sessionId: watcher.sessionId,
      modelId: watcher.modelId,
      value: outcome.value,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[watcher:${watcher.id}] Wake failed:`, err);
    return recordTick({
      watcherId: watcher.id,
      outcome: { ...outcome, status: "blocked", reason },
      // The ledger must not move past a report the user never received.
      advanceStore: false,
      fired: false,
    });
  }

  return recordTick({
    watcherId: watcher.id,
    outcome,
    store: evaluation.nextStore,
    advanceStore: true,
    fired: true,
  });
}

/**
 * Run a watcher's script once without recording it or waking anyone.
 *
 * This is how a script gets written: the model or the user runs it, sees what it
 * returns, and only then commits to a schedule. Running the real tick would wake
 * the agent on a match, which is the wrong price for looking.
 */
export async function previewWatcherTick(watcherId: string): Promise<TickOutcome> {
  const watcher = await prisma.scriptWatcher.findUnique({ where: { id: watcherId } });
  if (!watcher) {
    return {
      status: "blocked",
      reason: "Watcher not found",
      output: "",
      durationMs: 0,
      callCount: 0,
    };
  }

  const evaluation = await evaluate(watcher);
  return evaluation.outcome;
}

/**
 * Run a script that is not a watcher yet — the authoring loop.
 *
 * A script being written has no grant to check, so the decision that it may run
 * at all belongs to the tool policy that called this (`watcher_test` asks by
 * default). Nothing is recorded and nobody is woken.
 */
export async function previewScript(params: {
  userId: string;
  script: string;
  sessionId?: string | null;
}): Promise<TickOutcome> {
  const scopeId = params.sessionId ?? `watcher:preview-${params.userId}`;
  const { callable } = await loadWatcherToolAccess(params.userId, scopeId);

  const result = await runWatcherScript({
    script: params.script,
    tools: callable,
    store: {},
  });

  const measured = {
    output: result.output,
    durationMs: result.durationMs,
    callCount: result.callCount,
  };

  if (!result.ok) {
    return { ...measured, status: "error", reason: result.error ?? "Script failed" };
  }

  return isFiring(result.value)
    ? { ...measured, status: "fired", value: result.value }
    : { ...measured, status: "idle", value: result.value };
}
