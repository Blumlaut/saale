/**
 * Council reads and writes for the API and the room UI.
 *
 * Separate from `persist.ts`, which is the run loop's own narrow view of the
 * room: this module is everything a *browser* asks for — the list, the room, a
 * member's private turns — plus the writes the room's forms make. Every query is
 * scoped by `userId`, and a miss reads as "not found" rather than "not yours".
 *
 * Rows are mapped to the wire shapes in `@/types/council` here rather than in the
 * routes, so two routes cannot return the same entity in two shapes.
 */

import crypto from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import type {
  CouncilDetail,
  CouncilMemberView,
  CouncilMessageView,
  CouncilRunView,
  CouncilSummary,
  CouncilToolCall,
  CouncilTurnView,
} from "@/types/council";
import { allocateSandboxKey } from "./accounts";
import { normalizeOrchestration, normalizeStopVoteThreshold } from "./config";
import { pickMemberName } from "./names";
import type { CouncilCreateInput, CouncilUpdateInput, MemberInput } from "./schema";

/** The request was well-formed but cannot be applied — a 400. */
export class CouncilInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CouncilInputError";
  }
}

const iso = (value: Date | null | undefined): string | null => value?.toISOString() ?? null;

type CouncilRow = {
  id: string;
  name: string;
  brief: string;
  orchestration: string;
  stopVoteThreshold: string;
  toolConfig: unknown;
  maxDurationSeconds: number | null;
  maxTokens: number | null;
  maxCostUsd: number | null;
  status: string;
  sandboxReady: boolean;
  lastRunAt: Date | null;
  createdAt: Date;
};

function toolConfigOf(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, boolean>;
}

function toSummary(row: CouncilRow, counts: { members: number; enabled: number }): CouncilSummary {
  return {
    id: row.id,
    name: row.name,
    brief: row.brief,
    orchestration: normalizeOrchestration(row.orchestration),
    stopVoteThreshold: normalizeStopVoteThreshold(row.stopVoteThreshold),
    toolConfig: toolConfigOf(row.toolConfig),
    maxDurationSeconds: row.maxDurationSeconds,
    maxTokens: row.maxTokens,
    maxCostUsd: row.maxCostUsd,
    status: row.status,
    sandboxReady: row.sandboxReady,
    memberCount: counts.members,
    enabledMemberCount: counts.enabled,
    lastRunAt: iso(row.lastRunAt),
    createdAt: row.createdAt.toISOString(),
  };
}

type MemberRow = {
  id: string;
  name: string;
  instructions: string | null;
  modelProvider: string | null;
  modelName: string | null;
  thinkingLevel: string;
  toolConfig: unknown;
  enabled: boolean;
};

function toMemberView(row: MemberRow): CouncilMemberView {
  return {
    id: row.id,
    name: row.name,
    instructions: row.instructions,
    modelProvider: row.modelProvider,
    modelName: row.modelName,
    thinkingLevel: row.thinkingLevel,
    toolConfig: row.toolConfig ? toolConfigOf(row.toolConfig) : null,
    enabled: row.enabled,
  };
}

type RunRow = {
  id: string;
  status: string;
  stopReason: string | null;
  turnCount: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  error: string | null;
  maxDurationSeconds: number | null;
  maxTokens: number | null;
  maxCostUsd: number | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
};

function toRunView(row: RunRow): CouncilRunView {
  return {
    id: row.id,
    status: row.status as CouncilRunView["status"],
    stopReason: row.stopReason,
    turnCount: row.turnCount,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cost: row.cost,
    error: row.error,
    maxDurationSeconds: row.maxDurationSeconds,
    maxTokens: row.maxTokens,
    maxCostUsd: row.maxCostUsd,
    startedAt: iso(row.startedAt),
    completedAt: iso(row.completedAt),
    createdAt: row.createdAt.toISOString(),
  };
}

type TurnRow = {
  id: string;
  runId: string;
  memberId: string | null;
  memberName: string;
  status: string;
  thinking: string | null;
  toolCalls: string | null;
  finalText: string | null;
  postedSeqs: number[];
  triggeredBy: number[];
  seenThrough: number | null;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  error: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
};

/** Tool calls are stored as JSON; a malformed value must not break the subpage. */
function parseToolCalls(value: string | null): CouncilToolCall[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as CouncilToolCall[]) : [];
  } catch (err) {
    console.error("Stored council tool calls are not valid JSON:", err);
    return [];
  }
}

function toTurnView(row: TurnRow): CouncilTurnView {
  return {
    id: row.id,
    runId: row.runId,
    memberId: row.memberId,
    memberName: row.memberName,
    status: row.status as CouncilTurnView["status"],
    thinking: row.thinking,
    toolCalls: parseToolCalls(row.toolCalls),
    finalText: row.finalText,
    postedSeqs: row.postedSeqs,
    triggeredBy: row.triggeredBy,
    seenThrough: row.seenThrough,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cost: row.cost,
    error: row.error,
    startedAt: iso(row.startedAt),
    completedAt: iso(row.completedAt),
  };
}

// ─── Reads ───────────────────────────────────────────────────────────────────

export async function listCouncils(userId: string): Promise<CouncilSummary[]> {
  const rows = await prisma.council.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    include: { members: { select: { enabled: true } } },
  });

  return rows.map((row) =>
    toSummary(row, {
      members: row.members.length,
      enabled: row.members.filter((member) => member.enabled).length,
    }),
  );
}

export async function getCouncil(userId: string, councilId: string): Promise<CouncilDetail | null> {
  const row = await prisma.council.findFirst({
    where: { id: councilId, userId },
    include: {
      members: { orderBy: { createdAt: "asc" } },
      runs: { orderBy: { createdAt: "desc" }, take: 20 },
    },
  });
  if (!row) return null;

  const newest = await prisma.councilMessage.findFirst({
    where: { councilId, userId },
    orderBy: { seq: "desc" },
    select: { seq: true },
  });

  const runs = row.runs.map(toRunView);
  return {
    ...toSummary(row, {
      members: row.members.length,
      enabled: row.members.filter((member) => member.enabled).length,
    }),
    members: row.members.map(toMemberView),
    runs,
    lastSeq: newest?.seq ?? 0,
    activeRun: runs.find((run) => run.status === "running") ?? null,
  };
}

/** The room's messages, oldest first. */
export async function listRoomMessages(
  userId: string,
  councilId: string,
  options: { sinceSeq?: number; limit: number },
): Promise<CouncilMessageView[]> {
  const rows = await prisma.councilMessage.findMany({
    where: {
      councilId,
      userId,
      ...(options.sinceSeq !== undefined ? { seq: { gt: options.sinceSeq } } : {}),
    },
    orderBy: { seq: "desc" },
    take: options.limit,
  });

  return rows.reverse().map((row) => ({
    seq: row.seq,
    memberId: row.memberId,
    authorName: row.authorName,
    authorKind: row.authorKind as CouncilMessageView["authorKind"],
    content: row.content,
    addressedNames: row.mentions,
    runId: row.runId,
    createdAt: row.createdAt.toISOString(),
  }));
}

export async function listRuns(
  userId: string,
  councilId: string,
  limit: number,
): Promise<CouncilRunView[]> {
  const rows = await prisma.councilRun.findMany({
    where: { councilId, userId },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return rows.map(toRunView);
}

/** The run holding the council right now, if any. */
export async function findRunningRun(
  userId: string,
  councilId: string,
): Promise<CouncilRunView | null> {
  const row = await prisma.councilRun.findFirst({
    where: { councilId, userId, status: "running" },
    orderBy: { createdAt: "desc" },
  });
  return row ? toRunView(row) : null;
}

/**
 * A member's private turns, newest first.
 *
 * This is what its subpage shows: what woke it, what it reasoned, every tool
 * call and the closing text it never sent. `runId` narrows it to one run.
 */
export async function listMemberTurns(
  userId: string,
  councilId: string,
  options: { memberId: string; runId?: string; limit: number },
): Promise<CouncilTurnView[]> {
  const rows = await prisma.councilMemberTurn.findMany({
    where: {
      councilId,
      userId,
      memberId: options.memberId,
      ...(options.runId ? { runId: options.runId } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: options.limit,
  });
  return rows.map(toTurnView);
}

// ─── Writes ──────────────────────────────────────────────────────────────────

/** A member row minus the parent ids, which the caller supplies. */
type MemberData = Omit<Prisma.CouncilMemberUncheckedCreateInput, "councilId" | "userId">;

/** A member as it will be stored — name resolved, nothing else decided. */
function resolveMemberInput(
  input: MemberInput,
  takenNames: string[],
): { name: string; data: MemberData } {
  const name = input.name && input.name.length > 0 ? input.name : pickMemberName(takenNames);
  if (takenNames.some((existing) => existing.toLowerCase() === name.toLowerCase())) {
    throw new CouncilInputError(`Two members cannot both be called "${name}".`);
  }
  takenNames.push(name);

  return {
    name,
    data: {
      name,
      instructions: input.instructions ?? null,
      modelProvider: input.modelProvider ?? null,
      modelName: input.modelName ?? null,
      ...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}),
      // SQL NULL, not a JSON null: "this member has no selection of its own" is
      // an absent value, and reading it back must not look like `{}`.
      toolConfig: input.toolConfig ?? Prisma.DbNull,
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    },
  };
}

export async function createCouncil(
  userId: string,
  input: CouncilCreateInput,
): Promise<CouncilDetail> {
  // The id is generated here because the sandbox key is derived from it — the
  // council's Linux account has to be decided before the row exists.
  const id = crypto.randomUUID();
  const sandboxKey = await allocateSandboxKey(userId, id);

  const takenNames: string[] = [];
  const members = input.members.map((member) => resolveMemberInput(member, takenNames));

  const row = await prisma.council.create({
    data: {
      id,
      userId,
      name: input.name,
      brief: input.brief,
      orchestration: input.orchestration,
      stopVoteThreshold: input.stopVoteThreshold,
      toolConfig: input.toolConfig ?? Prisma.DbNull,
      maxDurationSeconds: input.maxDurationSeconds ?? null,
      maxTokens: input.maxTokens ?? null,
      maxCostUsd: input.maxCostUsd ?? null,
      sandboxKey,
      members: {
        create: members.map((member) => ({ userId, ...member.data })),
      },
    },
    include: { members: { orderBy: { createdAt: "asc" } } },
  });

  return {
    ...toSummary(row, {
      members: row.members.length,
      enabled: row.members.filter((member) => member.enabled).length,
    }),
    members: row.members.map(toMemberView),
    runs: [],
    lastSeq: 0,
    activeRun: null,
  };
}

export async function updateCouncil(
  userId: string,
  councilId: string,
  input: CouncilUpdateInput,
): Promise<CouncilDetail | null> {
  const updated = await prisma.council.updateMany({
    where: { id: councilId, userId },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.brief !== undefined ? { brief: input.brief } : {}),
      ...(input.orchestration !== undefined ? { orchestration: input.orchestration } : {}),
      ...(input.stopVoteThreshold !== undefined
        ? { stopVoteThreshold: input.stopVoteThreshold }
        : {}),
      ...(input.toolConfig !== undefined ? { toolConfig: input.toolConfig ?? Prisma.DbNull } : {}),
      ...(input.maxDurationSeconds !== undefined
        ? { maxDurationSeconds: input.maxDurationSeconds ?? null }
        : {}),
      ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens ?? null } : {}),
      ...(input.maxCostUsd !== undefined ? { maxCostUsd: input.maxCostUsd ?? null } : {}),
    },
  });
  if (updated.count === 0) return null;

  return (await getCouncil(userId, councilId)) ?? null;
}

export async function deleteCouncil(userId: string, councilId: string): Promise<boolean> {
  const deleted = await prisma.council.deleteMany({ where: { id: councilId, userId } });
  return deleted.count > 0;
}

export async function addMember(
  userId: string,
  councilId: string,
  input: MemberInput,
): Promise<CouncilMemberView | null> {
  const council = await prisma.council.findFirst({
    where: { id: councilId, userId },
    select: { id: true, members: { select: { name: true } } },
  });
  if (!council) return null;

  const member = resolveMemberInput(
    input,
    council.members.map((existing) => existing.name),
  );

  const row = await prisma.councilMember.create({
    data: { councilId, userId, ...member.data },
  });
  return toMemberView(row);
}

export async function updateMember(
  userId: string,
  councilId: string,
  memberId: string,
  input: MemberInput,
): Promise<CouncilMemberView | null> {
  if (input.name !== undefined && input.name.length > 0) {
    const clash = await prisma.councilMember.findFirst({
      where: { councilId, userId, name: input.name, id: { not: memberId } },
      select: { id: true },
    });
    if (clash) throw new CouncilInputError(`Another member is already called "${input.name}".`);
  }

  const updated = await prisma.councilMember.updateMany({
    where: { id: memberId, councilId, userId },
    data: {
      // A blank name keeps the existing one: renaming is deliberate, clearing the
      // field in the form is not.
      ...(input.name !== undefined && input.name.length > 0 ? { name: input.name } : {}),
      ...(input.instructions !== undefined ? { instructions: input.instructions ?? null } : {}),
      ...(input.modelProvider !== undefined ? { modelProvider: input.modelProvider ?? null } : {}),
      ...(input.modelName !== undefined ? { modelName: input.modelName ?? null } : {}),
      ...(input.thinkingLevel !== undefined ? { thinkingLevel: input.thinkingLevel } : {}),
      ...(input.toolConfig !== undefined ? { toolConfig: input.toolConfig ?? Prisma.DbNull } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    },
  });
  if (updated.count === 0) return null;

  const row = await prisma.councilMember.findFirst({ where: { id: memberId, councilId, userId } });
  return row ? toMemberView(row) : null;
}

export async function deleteMember(
  userId: string,
  councilId: string,
  memberId: string,
): Promise<boolean> {
  const deleted = await prisma.councilMember.deleteMany({
    where: { id: memberId, councilId, userId },
  });
  return deleted.count > 0;
}
