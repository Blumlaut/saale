/**
 * Starting, stopping and reporting council runs.
 *
 * This is the module's lifecycle layer: it decides whether a run may start,
 * prepares the environment it needs, dispatches the loop, and writes the run's
 * outcome. The loop itself (`orchestrator.ts`) knows nothing about the database
 * or the container, so the two can be reasoned about — and tested — separately.
 *
 * A run is **fire-and-forget inside the app process**, exactly as an agent job
 * is: the route returns the run id immediately and the owner watches it over the
 * room's SSE stream. That is also why the loop heartbeats and the watchdog
 * exists — a restarted process leaves a `running` row behind, and the run slot
 * is held by that status.
 */

import { isConfigured as isTerminalConfigured } from "@/lib/terminal/client";
import { isCategoryEnabled, type ToolConfig } from "@/lib/pi/tool-categories";
import {
  resolveRunBudget,
  normalizeOrchestration,
  normalizeStopVoteThreshold,
  type RunBudget,
} from "./config";
import { clearCouncilAbort, isCouncilAbortRequested, requestCouncilAbort } from "./abort";
import { sandboxIdentity } from "./accounts";
import { ensureCouncilSandbox } from "./sandbox";
import { publishCouncilEvent } from "./events";
import {
  runCouncilLoop,
  type CouncilRunDeps,
  type CouncilRunPlan,
  type CouncilRunStore,
} from "./orchestrator";
import {
  beginRun,
  failStaleRuns,
  finishRun,
  finishMemberTurn,
  lastRoomSeq,
  loadCouncil,
  markSandboxReady,
  postRoomMessage,
  readRoomMessages,
  readRoomWindow,
  setCouncilStatus,
  startMemberTurn,
  touchRun,
} from "./persist";
import { createCouncilMemberSession } from "./session";
import { findRunningRun } from "./store";

/** The council is already running — the caller should answer 409. */
export class CouncilBusyError extends Error {
  constructor(councilId: string) {
    super(`Council ${councilId} is already running`);
    this.name = "CouncilBusyError";
  }
}

/** The council does not exist, or is not this user's — answer 404 either way. */
export class CouncilNotFoundError extends Error {
  constructor(councilId: string) {
    super(`Council ${councilId} not found`);
    this.name = "CouncilNotFoundError";
  }
}

/** The run could not be started (no members, no usable sandbox). */
export class CouncilUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CouncilUnavailableError";
  }
}

export interface StartRunInput {
  councilId: string;
  userId: string;
  /** Ceilings for this run only; the council's own values fill the gaps. */
  budget?: Partial<RunBudget> | undefined;
  /**
   * Members the opening message addressed. Null (or omitted) wakes every enabled
   * member — the owner addressing nobody is asking the room as a whole.
   */
  openingMemberIds?: string[] | null;
  /** The room message that started this run, for the record. */
  triggerMessageId?: string | null;
}

/**
 * Begin a run and let it work in the background.
 *
 * Resolves with the run id as soon as the run exists: the loop keeps going after
 * the HTTP response, so the owner follows it in the room.
 */
export async function startCouncilRun(input: StartRunInput): Promise<{ runId: string }> {
  const loaded = await loadCouncil(input.councilId, input.userId);
  if (!loaded) throw new CouncilNotFoundError(input.councilId);

  const participants = loaded.members.filter((member) => member.enabled);
  if (participants.length === 0) {
    throw new CouncilUnavailableError("This council has no enabled members to run.");
  }

  const budget = resolveRunBudget(input.budget ?? {}, {
    maxDurationSeconds: loaded.council.maxDurationSeconds,
    maxTokens: loaded.council.maxTokens,
    maxCostUsd: loaded.council.maxCostUsd,
  });

  const started = await beginRun({
    councilId: input.councilId,
    userId: input.userId,
    budget,
    triggerMessageId: input.triggerMessageId ?? null,
  });
  if (!started) throw new CouncilBusyError(input.councilId);
  const { runId } = started;

  const identity = sandboxIdentity(loaded.council.sandboxKey);

  // A council that can write files needs its sandbox before the first turn: a
  // member that discovers halfway through that its workspace does not exist has
  // already spent the owner's money on a turn it cannot act on.
  const needsSandbox = participants.some((member) =>
    isCategoryEnabled(
      effectiveToolConfig(loaded.council.toolConfig, member.toolConfig),
      "terminal",
    ),
  );
  if (needsSandbox) {
    try {
      if (!isTerminalConfigured()) {
        throw new CouncilUnavailableError(
          "Council file tools need the Open Terminal integration (OPEN_TERMINAL_API_KEY). " +
            "Turn the Terminal tool off for this council to run without a workspace.",
        );
      }
      await ensureCouncilSandbox(identity);
      if (!loaded.council.sandboxReady) {
        await markSandboxReady(input.councilId, input.userId);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[council:${runId}] Sandbox not available:`, err);
      await finishRun(runId, { status: "failed", stopReason: "error", error: message });
      await setCouncilStatus(input.councilId, input.userId, "idle");
      throw err;
    }
  }

  const store = createRunStore({
    councilId: input.councilId,
    userId: input.userId,
    runId,
  });

  const plan: CouncilRunPlan = {
    councilId: input.councilId,
    userId: input.userId,
    runId,
    councilName: loaded.council.name,
    brief: loaded.council.brief,
    orchestration: normalizeOrchestration(loaded.council.orchestration),
    stopVoteThreshold: normalizeStopVoteThreshold(loaded.council.stopVoteThreshold),
    budget,
    toolConfig: loaded.council.toolConfig,
    toolExposure: null,
    sandboxKey: loaded.council.sandboxKey,
    members: loaded.members.map((member) => ({
      id: member.id,
      name: member.name,
      enabled: member.enabled,
      instructions: member.instructions,
      modelProvider: member.modelProvider,
      modelName: member.modelName,
      thinkingLevel: member.thinkingLevel,
      toolConfig: member.toolConfig,
    })),
    openingMemberIds: input.openingMemberIds ?? null,
    startedAfterSeq: await lastRoomSeq(input.councilId, input.userId),
  };

  const deps: CouncilRunDeps = {
    store,
    createSession: createCouncilMemberSession,
    publish: (event, data) => publishCouncilEvent(input.councilId, event as never, data),
    now: () => Date.now(),
    isAbortRequested: () => isCouncilAbortRequested(runId),
  };

  await publishCouncilEvent(input.councilId, "run_started", {
    runId,
    orchestration: plan.orchestration,
    members: participants.map((member) => member.name),
    budget,
  });

  void runCouncilLoop(plan, deps)
    .then(async (outcome) => {
      await finishRun(runId, {
        status: runStatus(outcome.awaitingUser, outcome.stopReason),
        stopReason: outcome.stopReason,
        error: outcome.error,
      });
      await setCouncilStatus(
        input.councilId,
        input.userId,
        outcome.awaitingUser ? "waiting" : "idle",
      );
      await clearCouncilAbort(runId).catch((err) => {
        console.error(`[council:${runId}] Failed to clear the abort flag:`, err);
      });
      await publishCouncilEvent(input.councilId, "run_ended", { runId, ...outcome });
    })
    .catch(async (err) => {
      // The loop handles its own failures, so this is the record-keeping failing.
      console.error(`[council:${runId}] Run failed outside the loop:`, err);
      await finishRun(runId, {
        status: "failed",
        stopReason: "error",
        error: err instanceof Error ? err.message : String(err),
      }).catch((recordErr) => {
        console.error(`[council:${runId}] Failed to record the run's failure:`, recordErr);
      });
      await setCouncilStatus(input.councilId, input.userId, "idle").catch((recordErr) => {
        console.error(`[council:${runId}] Failed to release the council:`, recordErr);
      });
      await publishCouncilEvent(input.councilId, "run_ended", {
        runId,
        stopReason: "error",
        error: err instanceof Error ? err.message : String(err),
      });
    });

  return { runId };
}

function runStatus(
  awaitingUser: boolean,
  stopReason: string,
): "completed" | "aborted" | "failed" | "waiting" {
  if (awaitingUser) return "waiting";
  if (stopReason === "aborted") return "aborted";
  if (stopReason === "error") return "failed";
  return "completed";
}

/** The tool selection that applies to a member: its own, else the council's. */
export function effectiveToolConfig(
  councilToolConfig: ToolConfig | null,
  memberToolConfig: ToolConfig | null,
): ToolConfig {
  return { ...(councilToolConfig ?? {}), ...(memberToolConfig ?? {}) };
}

/**
 * Ask a running council to stop.
 *
 * Resolves with the run that was asked, or null when nothing is running. The
 * request is a flag the loop polls, so this returns before the run has ended —
 * the room's stream reports when it does.
 */
export async function abortCouncilRun(input: {
  councilId: string;
  userId: string;
}): Promise<{ runId: string } | null> {
  const run = await findRunningRun(input.userId, input.councilId);
  if (!run) return null;

  await requestCouncilAbort(run.id);
  return { runId: run.id };
}

/**
 * Rescue runs left `running` by a process that went away.
 *
 * Called from the worker's sweep. Reports how many it failed.
 */
export async function sweepCouncilRuns(staleAfterMs: number): Promise<{ failed: number }> {
  return { failed: await failStaleRuns(staleAfterMs) };
}

/**
 * Wire the loop to the database.
 *
 * The loop's view of the room is bound to one run, so every message it posts
 * belongs to that run and every turn it records belongs to that member.
 */
function createRunStore(input: {
  councilId: string;
  userId: string;
  runId: string;
}): CouncilRunStore {
  const { councilId, userId, runId } = input;

  return {
    postMessage: async (message) =>
      postRoomMessage({
        councilId,
        userId,
        runId,
        authorKind: message.authorKind,
        memberId: message.memberId ?? null,
        authorName: message.authorName,
        content: message.content,
        mentions: message.mentions,
      }),

    messageWindow: async (window) => readRoomWindow({ councilId, userId, ...window }),

    // `council_read` reads *forward* from where the member left off (oldest
    // first), which is the opposite of the turn window's newest-first rule.
    messagesAfter: (read) =>
      readRoomMessages({
        councilId,
        userId,
        afterSeq: read.afterSeq,
        limit: read.limit,
        order: "oldest",
        ...(read.memberId ? { memberId: read.memberId } : {}),
      }),

    startTurn: async (turn) =>
      startMemberTurn({
        runId,
        councilId,
        userId,
        memberId: turn.memberId,
        memberName: turn.memberName,
        triggeredBy: turn.triggeredBy,
        seenThrough: turn.seenThrough,
      }),

    finishTurn: (turnId, record) => finishMemberTurn(turnId, record),

    progress: (totals) => touchRun(runId, totals),
  };
}
