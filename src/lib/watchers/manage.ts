/**
 * Creating and editing watchers. the one place the rules live.
 *
 * The API routes and the LLM's tools are two doors onto the same write, so the
 * validation and the scheduler sync happen here once. A route that
 * re-implemented any of it would be a second answer to "is this watcher allowed
 * to do that".
 */

import { prisma } from "@/lib/db";
import type { ScriptWatcher } from "@prisma/client";
import {
  DEFAULT_DELIVER,
  DEFAULT_RETENTION_MINUTES,
  DEFAULT_WORKTREE_MODE,
  isDeliverTarget,
  isWorktreeMode,
  MAX_RETENTION_MINUTES,
  type DeliverTarget,
} from "./delivery";
import { scheduleWatcher, syncWatcherSchedule, unscheduleWatcher } from "@/lib/queue";

/** Longest cooldown a watcher may be given: a week, in minutes. */
export const MAX_COOLDOWN_MINUTES = 7 * 24 * 60;

/** Used when a watcher is created without instructions for its wake. */
export const DEFAULT_WAKE_PROMPT =
  "Something changed. Review what the script reported and act on it, then tell me briefly what you did.";

/** A user-facing rejection of a watcher write. */
export class WatcherInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WatcherInputError";
  }
}

/**
 * A cron field made of numbers and the operators that combine them. a bare
 * wildcard, a step, a list, a range, or a range with a step.
 */
const NUMERIC_TOKEN = /^[0-9*,\-/]+$/;

/**
 * A cron field made of three-letter names. a single month or weekday, a range
 * of them, or a list of them. Names are what let a weekday or month field read
 * as English, and why the numeric rule alone cannot be the test.
 */
const NAMED_TOKEN = /^[A-Za-z]{3}(-[A-Za-z]{3})?(,[A-Za-z]{3}(-[A-Za-z]{3})?)*(\/\d{1,2})?$/;

/**
 * Whether one field is something cron can parse.
 *
 * The charset alone is too loose: it would accept prose ("nope"), which BullMQ
 * then rejects at scheduling time. leaving a saved watcher that never ticks,
 * which is the failure this validation exists to catch at the write instead.
 */
function isValidCronToken(token: string): boolean {
  if (!token) return false;
  if (NAMED_TOKEN.test(token)) return true;
  if (!NUMERIC_TOKEN.test(token)) return false;
  // The charset also allows separator soup ("---", "//") that has no numbers
  // and no wildcard, so it can never name a value.
  return /[0-9*]/.test(token);
}

/**
 * Validate a cron expression's shape.
 *
 * BullMQ parses the pattern for real; this only rejects what is obviously not a
 * cron expression, so a typo fails at the write with a message the user can act
 * on instead of silently never scheduling anything.
 */
export function normalizeCronExpression(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new WatcherInputError("A cron expression is required (for example '*/5 * * * *').");
  }

  const expression = value.trim().replace(/\s+/g, " ");
  const fields = expression.split(" ");

  if (fields.length !== 5 || !fields.every(isValidCronToken)) {
    throw new WatcherInputError(
      `"${value}" is not a 5-field cron expression (minute hour day month weekday).`,
    );
  }

  return expression;
}

function normalizeName(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new WatcherInputError("A name is required.");
  }
  const name = value.trim();
  if (name.length > 100) {
    throw new WatcherInputError("Name must be 100 characters or fewer.");
  }
  return name;
}

function normalizeScript(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new WatcherInputError("A script is required.");
  }
  return value;
}

function normalizeCooldown(value: unknown): number {
  if (value === undefined || value === null || value === "") return 0;
  const minutes = Number(value);
  if (!Number.isInteger(minutes) || minutes < 0) {
    throw new WatcherInputError("Cooldown must be a whole number of minutes.");
  }
  if (minutes > MAX_COOLDOWN_MINUTES) {
    throw new WatcherInputError(
      `Cooldown must be at most ${MAX_COOLDOWN_MINUTES} minutes (one week).`,
    );
  }
  return minutes;
}

/** Refuse a target conversation that is not the user's own. */
async function assertOwnsSession(userId: string, sessionId: string): Promise<void> {
  const session = await prisma.chatSession.findFirst({
    where: { id: sessionId, userId },
    select: { id: true },
  });
  if (!session) {
    throw new WatcherInputError(`Chat not found: ${sessionId}`);
  }
}

/** Refuse a project that is not the user's own. */
async function assertOwnsProject(userId: string, projectId: string): Promise<void> {
  const project = await prisma.coderProject.findFirst({
    where: { id: projectId, userId },
    select: { id: true },
  });
  if (!project) {
    throw new WatcherInputError(`Project not found: ${projectId}`);
  }
}

/** Where a fire goes, from what a caller sent. */
function normalizeDeliver(value: unknown): DeliverTarget {
  if (value === undefined || value === null || value === "") return DEFAULT_DELIVER;
  if (!isDeliverTarget(value)) {
    throw new WatcherInputError('Delivery must be "chat", "silent" or "coder".');
  }
  return value;
}

/** How many minutes a finished bot chat is kept. */
function normalizeRetention(value: unknown): number {
  if (value === undefined || value === null || value === "") return DEFAULT_RETENTION_MINUTES;
  const minutes = Number(value);
  if (!Number.isInteger(minutes) || minutes < 0) {
    throw new WatcherInputError("Retention must be a whole number of minutes.");
  }
  if (minutes > MAX_RETENTION_MINUTES) {
    throw new WatcherInputError(
      `Retention must be at most ${MAX_RETENTION_MINUTES} minutes (30 days).`,
    );
  }
  return minutes;
}

/** Fields every watcher write may set. */
export interface WatcherFields {
  name: string;
  description: string | null;
  script: string;
  cronExpression: string;
  deliver: DeliverTarget;
  sessionId: string | null;
  projectId: string | null;
  worktreeMode: string;
  retentionMinutes: number;
  wakePrompt: string;
  modelId: string | null;
  cooldownMinutes: number;
  enabled: boolean;
}

/** The fields a create or an update may set. */
export interface WatcherFieldInput {
  name: unknown;
  description?: unknown;
  script: unknown;
  cronExpression: unknown;
  deliver?: unknown;
  sessionId?: unknown;
  projectId?: unknown;
  worktreeMode?: unknown;
  retentionMinutes?: unknown;
  wakePrompt?: unknown;
  modelId?: unknown;
  cooldownMinutes?: unknown;
  enabled?: unknown;
}

/**
 * Create a watcher.
 *
 * It ticks from the moment it is created, whenever it was written. A tool the
 * script calls that would ask the user in a chat runs here without asking, which
 * is what an unattended script is.
 */
export async function createWatcher(params: {
  userId: string;
  fields: WatcherFieldInput;
}): Promise<{
  id: string;
  name: string;
  deliver: DeliverTarget;
}> {
  const { userId } = params;
  const fields = await validateFields(userId, params.fields);

  const existing = await prisma.scriptWatcher.findFirst({
    where: { userId, name: fields.name },
    select: { id: true },
  });
  if (existing) {
    throw new WatcherInputError(`A watcher named "${fields.name}" already exists.`);
  }

  const watcher = await prisma.scriptWatcher.create({
    data: { userId, ...fields },
  });

  await scheduleWatcher(watcher).catch((err) => {
    console.error(`Failed to schedule watcher ${watcher.id}:`, err);
  });

  return {
    id: watcher.id,
    name: watcher.name,
    deliver: watcher.deliver as DeliverTarget,
  };
}

/** Validate and normalize the fields of a create, and resolve defaults. */
async function validateFields(userId: string, input: WatcherFieldInput): Promise<WatcherFields> {
  const deliver = normalizeDeliver(input.deliver);

  // A chat fire is the one delivery that reports back into a conversation, so it
  // is the one delivery that holds a chat id. The rest run scoped to the watcher
  // and outlive any chat.
  const sessionId =
    deliver === "chat" && typeof input.sessionId === "string" && input.sessionId.trim()
      ? input.sessionId.trim()
      : null;
  if (sessionId) await assertOwnsSession(userId, sessionId);

  if (deliver === "chat" && !sessionId) {
    throw new WatcherInputError(
      "A watcher that reports into a conversation needs one. Pick a chat, dispatch into a project, or deliver from the script.",
    );
  }

  // Only a coder watcher has somewhere else to put a project, so switching the
  // delivery away from it clears the target rather than leaving a stale one.
  const projectId =
    deliver === "coder" && typeof input.projectId === "string" && input.projectId.trim()
      ? input.projectId.trim()
      : null;
  if (deliver === "coder") {
    if (!projectId) {
      throw new WatcherInputError("A watcher that dispatches into a project needs one.");
    }
    await assertOwnsProject(userId, projectId);
  }

  return {
    name: normalizeName(input.name),
    description: typeof input.description === "string" ? input.description.trim() || null : null,
    script: normalizeScript(input.script),
    cronExpression: normalizeCronExpression(input.cronExpression),
    deliver,
    sessionId,
    projectId,
    worktreeMode: isWorktreeMode(input.worktreeMode) ? input.worktreeMode : DEFAULT_WORKTREE_MODE,
    retentionMinutes: normalizeRetention(input.retentionMinutes),
    wakePrompt:
      typeof input.wakePrompt === "string" && input.wakePrompt.trim()
        ? input.wakePrompt.trim()
        : DEFAULT_WAKE_PROMPT,
    modelId:
      typeof input.modelId === "string" && input.modelId.trim() ? input.modelId.trim() : null,
    cooldownMinutes: normalizeCooldown(input.cooldownMinutes),
    enabled: input.enabled !== false,
  };
}

/**
 * Update a watcher.
 *
 * A changed script is simply the script it runs from the next tick on.
 */
export async function updateWatcher(params: {
  id: string;
  userId: string;
  fields: Partial<WatcherFieldInput>;
}): Promise<{ id: string; deliver: DeliverTarget }> {
  const { id, userId } = params;

  const current = await prisma.scriptWatcher.findFirst({ where: { id, userId } });
  if (!current) throw new WatcherInputError("Watcher not found.");

  // An explicit null clears a field; leaving it out keeps what the row has.
  const keep = (sent: unknown, stored: unknown): unknown => (sent === undefined ? stored : sent);

  const merged = await validateFields(userId, {
    name: keep(params.fields.name, current.name),
    description: keep(params.fields.description, current.description),
    script: keep(params.fields.script, current.script),
    cronExpression: keep(params.fields.cronExpression, current.cronExpression),
    deliver: keep(params.fields.deliver, current.deliver),
    sessionId: keep(params.fields.sessionId, current.sessionId),
    projectId: keep(params.fields.projectId, current.projectId),
    worktreeMode: keep(params.fields.worktreeMode, current.worktreeMode),
    retentionMinutes: keep(params.fields.retentionMinutes, current.retentionMinutes),
    wakePrompt: keep(params.fields.wakePrompt, current.wakePrompt),
    modelId: keep(params.fields.modelId, current.modelId),
    cooldownMinutes: keep(params.fields.cooldownMinutes, current.cooldownMinutes),
    enabled: keep(params.fields.enabled, current.enabled),
  });

  if (merged.name !== current.name) {
    const clash = await prisma.scriptWatcher.findFirst({
      where: { userId, name: merged.name, id: { not: id } },
      select: { id: true },
    });
    if (clash) throw new WatcherInputError(`A watcher named "${merged.name}" already exists.`);
  }

  const watcher = await prisma.scriptWatcher.update({
    where: { id },
    data: merged,
  });

  await syncWatcherSchedule(watcher).catch((err) => {
    console.error(`Failed to reschedule watcher ${watcher.id}:`, err);
  });

  return { id: watcher.id, deliver: merged.deliver };
}

/** Delete a watcher and stop its ticks. */
export async function deleteWatcher(id: string, userId: string): Promise<void> {
  const current = await prisma.scriptWatcher.findFirst({
    where: { id, userId },
    select: { id: true },
  });
  if (!current) throw new WatcherInputError("Watcher not found.");

  await prisma.scriptWatcher.delete({ where: { id } });
  await unscheduleWatcher(id);
}

/** The shape every reader of a watcher gets. API, tools and UI alike. */
export interface SerializedWatcher {
  id: string;
  name: string;
  description: string | null;
  script: string;
  cronExpression: string;
  enabled: boolean;
  deliver: string;
  sessionId: string | null;
  sessionTitle: string | null;
  projectId: string | null;
  projectName: string | null;
  worktreeMode: string;
  retentionMinutes: number;
  wakePrompt: string;
  modelId: string | null;
  cooldownMinutes: number;
  tickCount: number;
  fireCount: number;
  lastTickAt: string | null;
  lastFiredAt: string | null;
  lastError: string | null;
  lastValue: string | null;
  createdAt: string;
  updatedAt: string;
}

type WatcherRow = ScriptWatcher & {
  session?: { title: string } | null;
  project?: { name: string } | null;
};

export function serializeWatcher(watcher: WatcherRow): SerializedWatcher {
  return {
    id: watcher.id,
    name: watcher.name,
    description: watcher.description,
    script: watcher.script,
    cronExpression: watcher.cronExpression,
    enabled: watcher.enabled,
    deliver: watcher.deliver,
    sessionId: watcher.sessionId,
    sessionTitle: watcher.session?.title ?? null,
    projectId: watcher.projectId,
    projectName: watcher.project?.name ?? null,
    worktreeMode: watcher.worktreeMode,
    retentionMinutes: watcher.retentionMinutes,
    wakePrompt: watcher.wakePrompt,
    modelId: watcher.modelId,
    cooldownMinutes: watcher.cooldownMinutes,
    tickCount: watcher.tickCount,
    fireCount: watcher.fireCount,
    lastTickAt: watcher.lastTickAt?.toISOString() ?? null,
    lastFiredAt: watcher.lastFiredAt?.toISOString() ?? null,
    lastError: watcher.lastError,
    lastValue: watcher.lastValue,
    createdAt: watcher.createdAt.toISOString(),
    updatedAt: watcher.updatedAt.toISOString(),
  };
}
