/**
 * Council wire types.
 *
 * What the browse and room APIs return and the room UI renders. Kept apart from
 * the module's own shapes so a client component never has to import server code
 * (`import type` only): dates are ISO strings here, JSON columns are parsed, and
 * nothing carries a Prisma type.
 */

import type { CouncilOrchestration, StopVoteThreshold } from "@/lib/council/config";

/** A tool call a member made during a turn, as its subpage shows it. */
export interface CouncilToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result?: string;
  isError?: boolean;
}

export interface CouncilMemberView {
  id: string;
  name: string;
  instructions: string | null;
  modelProvider: string | null;
  modelName: string | null;
  thinkingLevel: string;
  /** Per-member tool selection; null inherits the council's. */
  toolConfig: Record<string, boolean> | null;
  enabled: boolean;
}

export interface CouncilRunView {
  id: string;
  status: "pending" | "running" | "waiting" | "completed" | "aborted" | "failed";
  stopReason: string | null;
  turnCount: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  error: string | null;
  maxDurationSeconds: number | null;
  maxTokens: number | null;
  maxCostUsd: number | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface CouncilSummary {
  id: string;
  name: string;
  brief: string;
  orchestration: CouncilOrchestration;
  stopVoteThreshold: StopVoteThreshold;
  toolConfig: Record<string, boolean>;
  maxDurationSeconds: number | null;
  maxTokens: number | null;
  maxCostUsd: number | null;
  status: string;
  sandboxReady: boolean;
  memberCount: number;
  enabledMemberCount: number;
  lastRunAt: string | null;
  createdAt: string;
}

export interface CouncilDetail extends CouncilSummary {
  members: CouncilMemberView[];
  /** The most recent runs, newest first. */
  runs: CouncilRunView[];
  /** Newest room sequence number, for the room's first fetch. */
  lastSeq: number;
  /** The run that is running right now, if any. */
  activeRun: CouncilRunView | null;
}

/** One member's turn inside a run — its private trace. */
export interface CouncilTurnView {
  id: string;
  runId: string;
  memberId: string | null;
  memberName: string;
  status: "running" | "completed" | "error";
  thinking: string | null;
  toolCalls: CouncilToolCall[];
  finalText: string | null;
  postedSeqs: number[];
  triggeredBy: number[];
  seenThrough: number | null;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

/** A message in the room — the shared read model, as the API returns it. */
export interface CouncilMessageView {
  seq: number;
  memberId: string | null;
  authorName: string;
  authorKind: "user" | "member" | "system";
  content: string;
  addressedNames: string[];
  runId: string | null;
  createdAt: string;
}
