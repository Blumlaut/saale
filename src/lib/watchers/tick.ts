/**
 * One automation tick, end to end: run the script, decide whether the result is
 * worth waking the agent for, and record what happened.
 *
 * The decision to spend tokens belongs here rather than in the script. A script
 * that could say "wake the agent" on every tick would be an unbounded spend
 * channel; a script that reports what it found, with the automation owning the
 * cooldown, the fire limit and the ledger, keeps the bound in the place the user
 * configured. An automation with no script has no gate at all: it fires on every
 * tick, which is what an agent job used to be.
 */

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { unscheduleWatcher } from "@/lib/queue";
import { loadWatcherToolAccess } from "./access";
import { applyStoreWrites, isFiring, runWatcherScript } from "./runner";
import { deliverWake } from "./wake";

/** Ticks kept per automation. Older rows are pruned after each tick. */
export const TICK_HISTORY_LIMIT = 50;

/** What one tick concluded. */
export type TickStatus =
  "idle" | "fired" | "reported" | "cooldown" | "finished" | "blocked" | "error";

export interface TickOutcome {
  status: TickStatus;
  /** The script's return value, when it returned one. */
  value?: unknown;
  /** Why the tick did not fire, or the failure, when the status alone does not say. */
  reason?: string;
  output: string;
  durationMs: number;
  callCount: number;
  /** The tools the script called, so a tick says what delivered it. */
  callNames: string[];
  /** The chat a fire was delivered into, if one was. */
  sessionId?: string | null;
  /** What the woken agent answered, when there was no chat to answer in. */
  answer?: string | null;
  /** Tokens the wake spent. */
  inputTokens?: number;
  outputTokens?: number;
}

/** The automation a tick runs for. */
type WatcherRow = Prisma.ScriptWatcherGetPayload<Record<string, never>>;

/** Reading a script's result: what it produced, and whether it is a report. */
interface Evaluation {
  watcher: WatcherRow;
  outcome: TickOutcome;
  /** The store as it would stand after this run. */
  nextStore: Record<string, unknown>;
  /** True when the script reported something. the wake decision is separate. */
  firing: boolean;
  /** Whether a script decided this, or the automation has no gate at all. */
  gated: boolean;
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
    console.error("Failed to encode automation tick value:", err);
    return null;
  }
}

/**
 * Run the script and read what came back.
 *
 * Writes nothing and wakes nobody: this is the whole of a tick's judgement, and
 * the caller decides whether to act on it (a scheduled tick does; a preview does
 * not).
 */
async function evaluate(watcher: WatcherRow): Promise<Evaluation> {
  // The chat it reports into, or the one that asked for it: a script that
  // sends a message acts as that chat.
  const scopeId = watcher.sessionId ?? watcher.originSessionId ?? `watcher:${watcher.id}`;
  const { callable } = await loadWatcherToolAccess(watcher.userId, scopeId);

  const store = readStore(watcher.store);
  const script = watcher.script?.trim() ?? "";

  // ── No script, no gate: every tick is news ───────────────────────────
  if (!script) {
    return {
      watcher,
      outcome: {
        status: "fired",
        output: "",
        durationMs: 0,
        callCount: 0,
        callNames: [],
      },
      nextStore: store,
      firing: true,
      gated: false,
    };
  }

  // ── The script ──────────────────────────────────────────────────────
  const result = await runWatcherScript({ script, tools: callable, store });

  const measured = {
    output: result.output,
    durationMs: result.durationMs,
    callCount: result.callCount,
    callNames: result.callNames,
  };

  if (!result.ok) {
    return {
      watcher,
      outcome: { ...measured, status: "error", reason: result.error ?? "Script failed" },
      nextStore: store,
      firing: false,
      gated: true,
    };
  }

  const nextStore = applyStoreWrites(store, result.storeWrites);

  // Nothing to report. the common case, and the reason a tick is cheap.
  if (!isFiring(result.value)) {
    return {
      watcher,
      outcome: { ...measured, status: "idle", value: result.value },
      nextStore,
      firing: false,
      gated: true,
    };
  }

  // A silent automation delivers from its own script (`tools.telegram_send`), so
  // a returned value is recorded and wakes nobody. Returning one is how the
  // script leaves a note in the log, not a second message to the user.
  if (watcher.deliver === "silent") {
    return {
      watcher,
      outcome: { ...measured, status: "reported", value: result.value },
      nextStore,
      firing: false,
      gated: true,
    };
  }

  return {
    watcher,
    outcome: { ...measured, status: "fired", value: result.value },
    nextStore,
    firing: true,
    gated: true,
  };
}

/**
 * Record a tick and advance the automation's counters.
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
      toolNames: outcome.callNames.slice(0, 50),
      sessionId: outcome.sessionId ?? null,
      answer: outcome.answer ? outcome.answer.slice(0, 20_000) : null,
      inputTokens: outcome.inputTokens ?? 0,
      outputTokens: outcome.outputTokens ?? 0,
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
      ...(options.store !== undefined ? { store: options.store as Prisma.InputJsonValue } : {}),
      ...(options.fired ? { fireCount: { increment: 1 }, lastFiredAt: new Date() } : {}),
    },
  });

  await pruneTicks(options.watcherId).catch((err) => {
    console.error(`Failed to prune ticks for automation ${options.watcherId}:`, err);
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
 * Switch an automation off once it has delivered every fire it was given.
 *
 * The row keeps its history and its definition, so raising or clearing the limit
 * is all it takes to start it again; deleting it would lose the log of what it
 * reported.
 */
async function finishWatcher(watcherId: string): Promise<void> {
  await prisma.scriptWatcher.update({
    where: { id: watcherId },
    data: { enabled: false },
  });

  await unscheduleWatcher(watcherId).catch((err) => {
    console.error(`Failed to unschedule a finished automation ${watcherId}:`, err);
  });
}

/**
 * Run one tick for an automation.
 *
 * Never throws: every outcome. including a script that failed and a wake that
 * could not be delivered. is a tick the log has to show, so each one is recorded
 * and returned.
 */
export async function runWatcherTick(watcherId: string): Promise<TickOutcome> {
  const watcher = await prisma.scriptWatcher.findUnique({ where: { id: watcherId } });

  if (!watcher || !watcher.enabled) {
    // The scheduler is removed by the caller for a disabled automation; a tick
    // that still arrives gets no row, so a removed automation cannot grow a log.
    return {
      status: "blocked",
      reason: watcher ? "Automation is disabled" : "Automation not found",
      output: "",
      durationMs: 0,
      callCount: 0,
      callNames: [],
    };
  }

  // ── The fire limit ──────────────────────────────────────────────────
  // A finished automation has nothing left to give, so the tick records why and
  // stops it rather than spending another one's worth of tokens.
  if (watcher.maxFires != null && watcher.fireCount >= watcher.maxFires) {
    const outcome = await recordTick({
      watcherId: watcher.id,
      outcome: {
        status: "finished",
        reason: `Fire limit reached (${watcher.maxFires})`,
        output: "",
        durationMs: 0,
        callCount: 0,
        callNames: [],
      },
      fired: false,
    });
    await finishWatcher(watcher.id);
    return outcome;
  }

  const evaluation = await evaluate(watcher);
  const { outcome } = evaluation;

  if (!evaluation.firing) {
    return recordTick({
      watcherId: watcher.id,
      outcome,
      store: evaluation.nextStore,
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
        fired: false,
      });
    }
  }

  // ── The wake ────────────────────────────────────────────────────────
  let delivered: Awaited<ReturnType<typeof deliverWake>>;
  try {
    delivered = await deliverWake({
      watcher: {
        id: watcher.id,
        userId: watcher.userId,
        name: watcher.name,
        deliver: watcher.deliver,
        sessionId: watcher.sessionId,
        originSessionId: watcher.originSessionId,
        projectId: watcher.projectId,
        worktreeMode: watcher.worktreeMode,
        stickySessionId: watcher.stickySessionId,
        wakePrompt: watcher.wakePrompt,
        modelId: watcher.modelId,
        thinkingLevel: watcher.thinkingLevel,
      },
      value: outcome.value,
      gated: evaluation.gated,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[automation:${watcher.id}] Wake failed:`, err);
    return recordTick({
      watcherId: watcher.id,
      outcome: { ...outcome, status: "blocked", reason },
      // The ledger must not move past a report the user never received.
      fired: false,
    });
  }

  const recorded = await recordTick({
    watcherId: watcher.id,
    outcome: {
      ...outcome,
      sessionId: delivered.sessionId,
      ...(delivered.answer === undefined ? {} : { answer: delivered.answer }),
      ...(delivered.inputTokens === undefined ? {} : { inputTokens: delivered.inputTokens }),
      ...(delivered.outputTokens === undefined ? {} : { outputTokens: delivered.outputTokens }),
      // The tools a standalone run called are how it delivered, so they belong
      // in the log next to the script's own.
      callNames: [...new Set([...outcome.callNames, ...(delivered.toolNames ?? [])])],
    },
    store: evaluation.nextStore,
    fired: true,
  });

  // ── The last fire ───────────────────────────────────────────────────
  if (watcher.maxFires != null && watcher.fireCount + 1 >= watcher.maxFires) {
    await finishWatcher(watcher.id);
  }

  return recorded;
}

/**
 * Run an automation's script once without recording it or waking anyone.
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
      reason: "Automation not found",
      output: "",
      durationMs: 0,
      callCount: 0,
      callNames: [],
    };
  }

  const evaluation = await evaluate(watcher);
  return evaluation.outcome;
}

/**
 * Run a script that is not an automation yet. the authoring loop.
 *
 * Testing a script spends the tools it calls, so the decision that it may run
 * at all belongs to the tool policy that called this (`automation_test` is
 * allowed by default, but the user can still gate it). Nothing is recorded and
 * nobody is woken.
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
    callNames: result.callNames,
  };

  if (!result.ok) {
    return { ...measured, status: "error", reason: result.error ?? "Script failed" };
  }

  return isFiring(result.value)
    ? { ...measured, status: "fired", value: result.value }
    : { ...measured, status: "idle", value: result.value };
}
