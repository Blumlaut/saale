/**
 * Council constants and the small decisions derived from them.
 *
 * Pure data. no database or Node-only imports. so the room UI can import the
 * same limits the orchestrator enforces. A value that could reasonably differ
 * per deployment belongs in an env var; these are the shape of the feature
 * itself (how many members, what a budget may be, how a vote resolves).
 */

import { TOOL_CATEGORIES, type ToolCategoryKey } from "@/lib/pi/tool-categories";
import { USER_HANDLE } from "./mentions";

/** How members take their turns. */
export type CouncilOrchestration = "parallel" | "round-robin";

/** Votes needed to stop a run. */
export type StopVoteThreshold = "majority" | "unanimous" | "any";

/** A run's ceilings. `null` where unlimited. */
export interface RunBudget {
  maxDurationSeconds: number | null;
  maxTokens: number | null;
  maxCostUsd: number | null;
}

/**
 * Budgets a run gets when neither the run nor the council names one.
 *
 * A council is a loop of models talking to each other: without a ceiling a
 * mention cycle can bill indefinitely, so "no budget" is never the default.
 * A council that wants none clears the values explicitly.
 */
export const DEFAULT_RUN_BUDGET: RunBudget = {
  maxDurationSeconds: 30 * 60,
  maxTokens: 2_000_000,
  maxCostUsd: 5,
};

/** A council needs two members to be a council, and no more than this. */
export const MIN_MEMBERS = 2;
export const MAX_MEMBERS = 8;

/**
 * The tool categories a council starts with: its own workspace, nothing else.
 *
 * A chat's defaults (email, Telegram, memory, …) are the wrong defaults here. A
 * council runs unattended in parallel, so a tool that reaches the owner's data
 *. `telegram_send` messaging them, `mail_send` writing on their behalf. has to
 * be a deliberate choice per council, not something inherited from the category
 * registry. Derived from `TOOL_CATEGORIES` so a new category arrives switched
 * off, and the council's stored `toolConfig` is an override on top of it.
 */
export const COUNCIL_DEFAULT_TOOL_CONFIG: Record<ToolCategoryKey, boolean> = Object.fromEntries(
  TOOL_CATEGORIES.map((category) => [category.key, category.key === "terminal"]),
) as Record<ToolCategoryKey, boolean>;

export const MAX_MEMBER_NAME_LENGTH = 50;
/** A sanity ceiling on a submitted cost budget, in USD. */
export const MAX_COST_USD = 1000;
export const MAX_COUNCIL_NAME_LENGTH = 100;
export const MAX_BRIEF_LENGTH = 4000;
export const MAX_MESSAGE_LENGTH = 8000;

/**
 * How many room messages a running loop looks through for ones it did not post.
 *
 * Only the owner speaks into a room without going through the loop, and they
 * speak rarely; the window exists so a burst cannot make the loop fetch the
 * whole room on every iteration.
 */
export const ROOM_ABSORB_LIMIT = 50;

/** How many room messages one API page returns. */
export const MAX_ROOM_PAGE = 500;

/**
 * How many room messages a single turn prompt carries.
 *
 * A member that has been asleep for a long run must be woken with what it
 * missed, but the oldest messages matter least. and the run's own budget is
 * the real bound on how much can accumulate. The window is applied newest-first.
 */
export const TRANSCRIPT_WINDOW = 80;

/**
 * Character ceiling for one turn's room history.
 *
 * A count is not a bound on size: messages run to `MAX_MESSAGE_LENGTH` each, so
 * the window alone could spend a whole model context on the transcript before
 * the member has read its own instructions. The newest messages are kept until
 * this is reached (at least one message always is, however long).
 */
export const TRANSCRIPT_MAX_CHARS = 60_000;

/**
 * Length of a council's sandbox key, in characters.
 *
 * Open Terminal derives a Linux username by taking the first 8 alphanumeric
 * characters of `X-User-Id`, so a key longer than this is truncated. the whole
 * key must fit for the account to be the one we think it is (see `accounts.ts`).
 */
export const SANDBOX_KEY_LENGTH = 8;

/**
 * Slack added to a run's wall-clock budget before the watchdog declares it
 * abandoned, covering the turn that was in flight when the budget expired.
 */
export const WATCHDOG_GRACE_SECONDS = 90;

/**
 * How often an in-flight turn asks whether the run was stopped.
 *
 * The loop checks between turns, but a turn can be minutes long. an owner who
 * presses Stop expects it to land while the model is still working, not after.
 */
export const ABORT_POLL_MS = 750;

/**
 * How often a running loop reports that it is alive.
 *
 * A single turn can legitimately run for minutes, so a heartbeat tied to turn
 * boundaries would look identical to a dead loop. It is a timer instead, which
 * is what makes "this run stopped reporting" mean the process went away.
 */
export const HEARTBEAT_MS = 15_000;

/** Options for the room's mode selector. */
export const COUNCIL_ORCHESTRATIONS: Array<{
  value: CouncilOrchestration;
  label: string;
  description: string;
}> = [
  {
    value: "parallel",
    label: "Parallel",
    description: "Every member runs at once; a message wakes the members it names.",
  },
  {
    value: "round-robin",
    label: "Round-robin",
    description: "One member speaks at a time, in list order, round after round.",
  },
];

/** Options for the stop-vote threshold. */
export const STOP_VOTE_THRESHOLDS: Array<{
  value: StopVoteThreshold;
  label: string;
  description: string;
}> = [
  {
    value: "majority",
    label: "Majority",
    description: "More than half of the enabled members must vote to stop.",
  },
  {
    value: "unanimous",
    label: "Unanimous",
    description: "Every enabled member must vote to stop.",
  },
  {
    value: "any",
    label: "Any one",
    description: "A single member can stop the run.",
  },
];

/**
 * Votes required to stop a run of `memberCount` enabled members.
 *
 * A council with no enabled members resolves to 0. the run has nothing to do
 * and is stopped as soon as it starts, rather than waiting for a vote that can
 * never arrive.
 */
export function stopVoteQuorum(threshold: StopVoteThreshold, memberCount: number): number {
  if (memberCount <= 0) return 0;
  switch (threshold) {
    case "any":
      return 1;
    case "unanimous":
      return memberCount;
    case "majority":
      return Math.floor(memberCount / 2) + 1;
  }
}

export function isCouncilOrchestration(value: unknown): value is CouncilOrchestration {
  return value === "parallel" || value === "round-robin";
}

export function isStopVoteThreshold(value: unknown): value is StopVoteThreshold {
  return value === "majority" || value === "unanimous" || value === "any";
}

export function normalizeOrchestration(value: unknown): CouncilOrchestration {
  return isCouncilOrchestration(value) ? value : "parallel";
}

export function normalizeStopVoteThreshold(value: unknown): StopVoteThreshold {
  return isStopVoteThreshold(value) ? value : "majority";
}

/**
 * Read one budget ceiling from stored or submitted input.
 *
 * `undefined` and `null` mean "not set", so the fallback applies. a council
 * (or a run) that was never given a ceiling inherits one. `0` means unlimited:
 * the column is nullable and a zero ceiling would stop the run the moment it
 * started, which is never what clearing a field means, so the value has to be
 * reserved for the one thing a user could plausibly ask for. Anything else that
 * is not a positive finite number falls back, so a bad value fails safe.
 */
function budgetCeiling(value: unknown, fallback: number | null): number | null {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return fallback;
  return value === 0 ? null : value;
}

/** Resolve a run's budget: the run's own values, else the council's, else the default. */
export function resolveRunBudget(
  run: Partial<RunBudget> | null | undefined,
  council: Partial<RunBudget> | null | undefined,
): RunBudget {
  const defaults = DEFAULT_RUN_BUDGET;
  const fromCouncil: RunBudget = {
    maxDurationSeconds: budgetCeiling(council?.maxDurationSeconds, defaults.maxDurationSeconds),
    maxTokens: budgetCeiling(council?.maxTokens, defaults.maxTokens),
    maxCostUsd: budgetCeiling(council?.maxCostUsd, defaults.maxCostUsd),
  };
  return {
    maxDurationSeconds: budgetCeiling(run?.maxDurationSeconds, fromCouncil.maxDurationSeconds),
    maxTokens: budgetCeiling(run?.maxTokens, fromCouncil.maxTokens),
    maxCostUsd: budgetCeiling(run?.maxCostUsd, fromCouncil.maxCostUsd),
  };
}

/** The handle that addresses the human, re-exported for the room UI. */
export { USER_HANDLE };
