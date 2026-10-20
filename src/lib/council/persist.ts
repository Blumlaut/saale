/**
 * Council database access.
 *
 * Every query is scoped by `userId`. including the ones that address a row by
 * its own id, because an id alone is guessable and a council is a user's
 * private workspace. The child rows carry a denormalized `userId` for exactly
 * that reason (the same shape `AgentRun` uses).
 *
 * The one thing this module is careful *not* to do is read a council's members
 * per message. Mentions are stored as **names**, so a transcript renders without
 * a join and survives a member being renamed or deleted; only wake routing needs
 * ids, and that happens at post time against the live roster.
 */

import { prisma } from "@/lib/db";
import type { ToolConfig } from "@/lib/pi/tool-categories";
import type { RunBudget } from "./config";
import type { RoomAuthorKind, RoomMessageView } from "./room";

/** A council as the run loop needs it. */
export interface CouncilRecord {
  id: string;
  userId: string;
  name: string;
  brief: string;
  orchestration: string;
  stopVoteThreshold: string;
  toolConfig: ToolConfig | null;
  maxDurationSeconds: number | null;
  maxTokens: number | null;
  maxCostUsd: number | null;
  sandboxKey: string;
  sandboxReady: boolean;
  status: string;
}

export interface CouncilMemberRecord {
  id: string;
  name: string;
  enabled: boolean;
  instructions: string | null;
  modelProvider: string | null;
  modelName: string | null;
  thinkingLevel: string;
  toolConfig: ToolConfig | null;
}

/** A council with its members, or null when it is not this user's. */
export async function loadCouncil(
  councilId: string,
  userId: string,
): Promise<{ council: CouncilRecord; members: CouncilMemberRecord[] } | null> {
  const council = await prisma.council.findFirst({
    where: { id: councilId, userId },
    include: { members: { orderBy: { createdAt: "asc" } } },
  });
  if (!council) return null;

  return {
    council: {
      id: council.id,
      userId: council.userId,
      name: council.name,
      brief: council.brief,
      orchestration: council.orchestration,
      stopVoteThreshold: council.stopVoteThreshold,
      toolConfig: (council.toolConfig as ToolConfig | null) ?? null,
      maxDurationSeconds: council.maxDurationSeconds,
      maxTokens: council.maxTokens,
      maxCostUsd: council.maxCostUsd,
      sandboxKey: council.sandboxKey,
      sandboxReady: council.sandboxReady,
      status: council.status,
    },
    members: council.members.map((member) => ({
      id: member.id,
      name: member.name,
      enabled: member.enabled,
      instructions: member.instructions,
      modelProvider: member.modelProvider,
      modelName: member.modelName,
      thinkingLevel: member.thinkingLevel,
      toolConfig: (member.toolConfig as ToolConfig | null) ?? null,
    })),
  };
}

/** The owner's display name, for messages they post into the room. */
export async function loadOwnerName(userId: string): Promise<string> {
  const user = await prisma.user.findFirst({
    where: { id: userId },
    select: { name: true, username: true },
  });
  return user?.name?.trim() || user?.username?.trim() || "the owner";
}

/**
 * The next room sequence number, allocated atomically.
 *
 * `UPDATE … RETURNING` rather than read-then-write: parallel members post at the
 * same time, and two messages that read the same counter would collide on the
 * `(councilId, seq)` unique index. or worse, silently take the same number and
 * make the room ambiguous to read. Parameterized, so nothing is interpolated.
 */
async function allocateSeq(councilId: string, userId: string): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ nextSeq: number }>>`
    UPDATE "Council" SET "nextSeq" = "nextSeq" + 1
    WHERE "id" = ${councilId} AND "userId" = ${userId}
    RETURNING "nextSeq"
  `;
  const seq = rows[0]?.nextSeq;
  if (typeof seq !== "number") {
    throw new Error(`Council ${councilId} not found for user ${userId}`);
  }
  return seq;
}

export interface PostMessageInput {
  councilId: string;
  userId: string;
  runId: string | null;
  authorKind: RoomAuthorKind;
  memberId?: string | null;
  authorName: string;
  content: string;
  /** Names this message addressed, plus "user" and/or "all". */
  mentions: string[];
}

/**
 * Append a message to the room.
 *
 * Returns the stored row's id alongside the read model: the API records it as a
 * run's trigger, and the loop only cares about the view.
 */
export async function postRoomMessage(
  input: PostMessageInput,
): Promise<RoomMessageView & { id: string }> {
  const seq = await allocateSeq(input.councilId, input.userId);

  const message = await prisma.councilMessage.create({
    data: {
      councilId: input.councilId,
      userId: input.userId,
      runId: input.runId,
      seq,
      authorKind: input.authorKind,
      memberId: input.memberId ?? null,
      authorName: input.authorName,
      content: input.content,
      mentions: input.mentions,
    },
  });

  return {
    id: message.id,
    seq: message.seq,
    memberId: message.memberId,
    authorName: message.authorName,
    authorKind: message.authorKind as RoomAuthorKind,
    content: message.content,
    addressedNames: message.mentions,
  };
}

function toView(message: {
  seq: number;
  memberId: string | null;
  authorName: string;
  authorKind: string;
  content: string;
  mentions: string[];
}): RoomMessageView {
  return {
    seq: message.seq,
    memberId: message.memberId,
    authorName: message.authorName,
    authorKind: message.authorKind as RoomAuthorKind,
    content: message.content,
    addressedNames: message.mentions,
  };
}

/**
 * Room messages, oldest first in the result.
 *
 * `order` picks which end of the room the window comes from: `newest` (the
 * default) answers "what has just been said", `oldest` answers "read on from
 * here". which is what a member asking for the room after a given message
 * means. Both return ascending, because the room reads that way.
 */
export async function readRoomMessages(input: {
  councilId: string;
  userId: string;
  afterSeq?: number;
  limit: number;
  memberId?: string;
  order?: "oldest" | "newest";
}): Promise<RoomMessageView[]> {
  const rows = await prisma.councilMessage.findMany({
    where: {
      councilId: input.councilId,
      userId: input.userId,
      ...(input.afterSeq !== undefined ? { seq: { gt: input.afterSeq } } : {}),
      ...(input.memberId ? { memberId: input.memberId } : {}),
    },
    orderBy: { seq: input.order === "oldest" ? "asc" : "desc" },
    take: input.limit,
  });
  return (input.order === "oldest" ? rows : rows.reverse()).map(toView);
}

/**
 * The newest `limit` messages after `afterSeq`, plus how many newer messages
 * were left out.
 *
 * A member that has been idle through a long run must be woken with what it
 * missed, and only the newest part of that fits in a prompt. Reporting the
 * skipped count is what lets the turn prompt say so instead of implying the
 * member has seen everything. a silently truncated room reads as a complete one.
 */
export async function readRoomWindow(input: {
  councilId: string;
  userId: string;
  afterSeq: number;
  limit: number;
}): Promise<{ messages: RoomMessageView[]; skippedBefore: number }> {
  const [total, rows] = await Promise.all([
    prisma.councilMessage.count({
      where: {
        councilId: input.councilId,
        userId: input.userId,
        seq: { gt: input.afterSeq },
      },
    }),
    prisma.councilMessage.findMany({
      where: {
        councilId: input.councilId,
        userId: input.userId,
        seq: { gt: input.afterSeq },
      },
      orderBy: { seq: "desc" },
      take: input.limit,
    }),
  ]);

  return {
    messages: rows.reverse().map(toView),
    skippedBefore: Math.max(0, total - rows.length),
  };
}

/** The newest room sequence number, 0 for an empty room. */
export async function lastRoomSeq(councilId: string, userId: string): Promise<number> {
  const newest = await prisma.councilMessage.findFirst({
    where: { councilId, userId },
    orderBy: { seq: "desc" },
    select: { seq: true },
  });
  return newest?.seq ?? 0;
}

// ─── Runs ────────────────────────────────────────────────────────────────────

export interface CreateRunInput {
  councilId: string;
  userId: string;
  budget: RunBudget;
  triggerMessageId: string | null;
}

/**
 * Take the run slot and create the run record.
 *
 * The status update is the reservation: it is conditional on a status that is
 * not `running`, so two clicks (or two replicas) cannot both start a run. the
 * loser's update matches no rows and is told the council is busy. No separate
 * lock is needed, and none could be more reliable than the row itself.
 */
export async function beginRun(input: CreateRunInput): Promise<{ runId: string } | null> {
  const reservation = await prisma.council.updateMany({
    where: { id: input.councilId, userId: input.userId, status: { not: "running" } },
    data: { status: "running", lastRunAt: new Date() },
  });
  if (reservation.count === 0) return null;

  const run = await prisma.councilRun.create({
    data: {
      councilId: input.councilId,
      userId: input.userId,
      status: "running",
      startedAt: new Date(),
      lastHeartbeatAt: new Date(),
      triggerMessageId: input.triggerMessageId,
      maxDurationSeconds: input.budget.maxDurationSeconds,
      maxTokens: input.budget.maxTokens,
      maxCostUsd: input.budget.maxCostUsd,
    },
  });

  return { runId: run.id };
}

export interface RunProgress {
  inputTokens: number;
  outputTokens: number;
  cost: number;
  turnCount: number;
}

/** Record a heartbeat and the run's running totals. */
export async function touchRun(runId: string, progress?: RunProgress): Promise<void> {
  await prisma.councilRun.update({
    where: { id: runId },
    data: {
      lastHeartbeatAt: new Date(),
      ...(progress
        ? {
            inputTokens: progress.inputTokens,
            outputTokens: progress.outputTokens,
            cost: progress.cost,
            turnCount: progress.turnCount,
          }
        : {}),
    },
  });
}

export async function finishRun(
  runId: string,
  data: {
    status: "completed" | "aborted" | "failed" | "waiting";
    stopReason: string;
    error?: string | null;
  },
): Promise<void> {
  await prisma.councilRun.update({
    where: { id: runId },
    data: {
      status: data.status,
      stopReason: data.stopReason,
      completedAt: data.status === "waiting" ? null : new Date(),
      ...(data.error !== undefined ? { error: data.error } : {}),
    },
  });
}

/** Set the council's own status (running | idle | waiting | completed | failed). */
export async function setCouncilStatus(
  councilId: string,
  userId: string,
  status: string,
): Promise<void> {
  await prisma.council.updateMany({
    where: { id: councilId, userId },
    data: { status },
  });
}

export async function markSandboxReady(councilId: string, userId: string): Promise<void> {
  await prisma.council.updateMany({
    where: { id: councilId, userId },
    data: { sandboxReady: true },
  });
}

// ─── Turns ───────────────────────────────────────────────────────────────────

export async function startMemberTurn(input: {
  runId: string;
  councilId: string;
  userId: string;
  memberId: string;
  memberName: string;
  triggeredBy: number[];
  seenThrough: number | null;
}): Promise<string> {
  const turn = await prisma.councilMemberTurn.create({
    data: {
      runId: input.runId,
      councilId: input.councilId,
      userId: input.userId,
      memberId: input.memberId,
      memberName: input.memberName,
      triggeredBy: input.triggeredBy,
      seenThrough: input.seenThrough,
      status: "running",
      startedAt: new Date(),
    },
  });
  return turn.id;
}

export interface FinishTurnInput {
  /** `preempted` is an intentional early end (the member was addressed), not an error. */
  status: "completed" | "preempted" | "error";
  thinking: string | null;
  toolCalls: string | null;
  finalText: string | null;
  postedSeqs: number[];
  inputTokens: number;
  outputTokens: number;
  cost: number;
  error?: string | null;
}

export async function finishMemberTurn(turnId: string, data: FinishTurnInput): Promise<void> {
  await prisma.councilMemberTurn.update({
    where: { id: turnId },
    data: {
      status: data.status,
      thinking: data.thinking,
      toolCalls: data.toolCalls,
      finalText: data.finalText,
      postedSeqs: data.postedSeqs,
      inputTokens: data.inputTokens,
      outputTokens: data.outputTokens,
      cost: data.cost,
      completedAt: new Date(),
      ...(data.error !== undefined ? { error: data.error } : {}),
    },
  });
}

// ─── Orphan rescue ───────────────────────────────────────────────────────────

/**
 * Runs left `running` by a process that went away.
 *
 * A run's loop lives in the web process, so a restart kills it silently. the
 * row would otherwise claim to be running forever and block every later run
 * (the reservation refuses to start while the status is `running`). A heartbeat
 * older than `staleAfterMs` is the only evidence available, and marking it
 * failed is recoverable: the user can start a new run.
 */
export async function failStaleRuns(staleAfterMs: number, userId?: string): Promise<number> {
  const cutoff = new Date(Date.now() - staleAfterMs);
  const stale = await prisma.councilRun.findMany({
    where: {
      status: "running",
      ...(userId ? { userId } : {}),
      OR: [{ lastHeartbeatAt: null }, { lastHeartbeatAt: { lt: cutoff } }],
    },
    select: { id: true, councilId: true, userId: true },
  });

  for (const run of stale) {
    await prisma.councilRun.update({
      where: { id: run.id },
      data: {
        status: "failed",
        stopReason: "timeout",
        error: "The run stopped responding (the app restarted or the run was abandoned).",
        completedAt: new Date(),
      },
    });
    await setCouncilStatus(run.councilId, run.userId, "idle");
  }

  return stale.length;
}
