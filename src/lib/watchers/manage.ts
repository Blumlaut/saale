/**
 * Creating, editing and approving watchers — the one place the rules live.
 *
 * The API routes and the LLM's tools are two doors onto the same write, so the
 * validation, the grant and the scheduler sync happen here once. A route that
 * re-implemented any of it would be a second answer to "is this watcher allowed
 * to do that".
 *
 * The grant is derived from the script at save time. The *approval* is the human
 * gate on the write path: the API is session-authenticated and the UI dialog
 * shows the consent list before saving, while a write from the model's tools
 * lands pending (`UNAPPROVED_SCRIPT_HASH`) unless the script needs no consent at
 * all — a watcher runs unattended, so its approval cannot come from the thing
 * that benefits from it. `checkGrant` then catches what moves afterwards — a
 * rewritten script through a path that skipped approval, a tool switched off, a
 * policy turned to `ask`.
 */

import { prisma } from "@/lib/db";
import type { ScriptWatcher } from "@prisma/client";
import { hashScript, consentFor, UNAPPROVED_SCRIPT_HASH } from "./grant";
import { loadWatcherToolAccess } from "./access";
import { scheduleWatcher, syncWatcherSchedule, unscheduleWatcher } from "@/lib/queue";

/**
 * Scope a tool set for a watcher that does not exist yet.
 *
 * Only the tool *names* feed a grant and those do not depend on the scope, so a
 * grant can be read before the row (and its id) exists.
 */
const PENDING_SCOPE = "watcher:pending";

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
 * A cron field made of numbers and the operators that combine them — a bare
 * wildcard, a step, a list, a range, or a range with a step.
 */
const NUMERIC_TOKEN = /^[0-9*,\-/]+$/;

/**
 * A cron field made of three-letter names — a single month or weekday, a range
 * of them, or a list of them. Names are what let a weekday or month field read
 * as English, and why the numeric rule alone cannot be the test.
 */
const NAMED_TOKEN = /^[A-Za-z]{3}(-[A-Za-z]{3})?(,[A-Za-z]{3}(-[A-Za-z]{3})?)*(\/\d{1,2})?$/;

/**
 * Whether one field is something cron can parse.
 *
 * The charset alone is too loose: it would accept prose ("nope"), which BullMQ
 * then rejects at scheduling time — leaving a saved watcher that never ticks,
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

/** Fields every watcher write may set. */
export interface WatcherFields {
  name: string;
  description: string | null;
  script: string;
  cronExpression: string;
  sessionId: string | null;
  wakePrompt: string;
  modelId: string | null;
  cooldownMinutes: number;
  enabled: boolean;
}

/**
 * Create a watcher, deriving its grant from the script.
 *
 * `approvedByUser` says whether a person read the script behind this write. The
 * API sets it — the dialog shows the consent list before saving — and the
 * model's tool does not, so a script the model wrote only starts running once
 * the user has approved it on the Watchers page.
 *
 * A script that reaches nothing the user has to consent to is the same either
 * way: there is nothing to approve, so it ticks from the moment it is created.
 * The pending state is only for a script that would call an `ask` or `auto`
 * tool unattended, which is exactly what the approval exists to cover.
 */
export async function createWatcher(params: {
  userId: string;
  fields: {
    name: unknown;
    description?: unknown;
    script: unknown;
    cronExpression: unknown;
    sessionId?: unknown;
    wakePrompt?: unknown;
    modelId?: unknown;
    cooldownMinutes?: unknown;
    enabled?: unknown;
  };
  /** Whether a human read this script: the dialog on the API, never a tool call. */
  approvedByUser: boolean;
}): Promise<{
  id: string;
  name: string;
  grantedTools: string[];
  grantAll: boolean;
  needsApproval: boolean;
}> {
  const { userId } = params;
  const fields = await validateFields(userId, params.fields);

  const access = await loadWatcherToolAccess(userId, fields.sessionId ?? PENDING_SCOPE);
  const consent = consentFor({
    script: fields.script,
    callableNames: access.callableNames,
    toolPolicies: access.toolPolicies,
  });

  const needsApproval =
    !params.approvedByUser && (consent.grantedTools.length > 0 || consent.grantAll);

  const existing = await prisma.scriptWatcher.findFirst({
    where: { userId, name: fields.name },
    select: { id: true },
  });
  if (existing) {
    throw new WatcherInputError(`A watcher named "${fields.name}" already exists.`);
  }

  const watcher = await prisma.scriptWatcher.create({
    data: {
      userId,
      ...fields,
      scriptHash: needsApproval ? UNAPPROVED_SCRIPT_HASH : consent.scriptHash,
      grantedTools: consent.grantedTools,
      grantAll: consent.grantAll,
    },
  });

  await scheduleWatcher(watcher).catch((err) => {
    console.error(`Failed to schedule watcher ${watcher.id}:`, err);
  });

  return {
    id: watcher.id,
    name: watcher.name,
    grantedTools: consent.grantedTools,
    grantAll: consent.grantAll,
    needsApproval,
  };
}

/** Validate and normalize the fields of a create, and resolve defaults. */
async function validateFields(
  userId: string,
  input: {
    name: unknown;
    description?: unknown;
    script: unknown;
    cronExpression: unknown;
    sessionId?: unknown;
    wakePrompt?: unknown;
    modelId?: unknown;
    cooldownMinutes?: unknown;
    enabled?: unknown;
  },
): Promise<WatcherFields> {
  const sessionId =
    typeof input.sessionId === "string" && input.sessionId.trim() ? input.sessionId.trim() : null;
  if (sessionId) await assertOwnsSession(userId, sessionId);

  return {
    name: normalizeName(input.name),
    description: typeof input.description === "string" ? input.description.trim() || null : null,
    script: normalizeScript(input.script),
    cronExpression: normalizeCronExpression(input.cronExpression),
    sessionId,
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
 * A changed script does **not** re-earn its grant unless the caller says the
 * user approved it (`approveScript`). The API sets that because the user is
 * editing the script in front of them; the LLM's tools do not, so a model that
 * rewrites a watcher's script leaves it blocked until the user says yes — an
 * approval must not be extendable by the thing it constrains.
 */
export async function updateWatcher(params: {
  id: string;
  userId: string;
  fields: Partial<{
    name: unknown;
    description: unknown;
    script: unknown;
    cronExpression: unknown;
    sessionId: unknown;
    wakePrompt: unknown;
    modelId: unknown;
    cooldownMinutes: unknown;
    enabled: unknown;
  }>;
  approveScript: boolean;
}): Promise<{ id: string; needsApproval: boolean }> {
  const { id, userId } = params;

  const current = await prisma.scriptWatcher.findFirst({ where: { id, userId } });
  if (!current) throw new WatcherInputError("Watcher not found.");

  const merged = await validateFields(userId, {
    name: params.fields.name ?? current.name,
    description: params.fields.description ?? current.description,
    script: params.fields.script ?? current.script,
    cronExpression: params.fields.cronExpression ?? current.cronExpression,
    sessionId: params.fields.sessionId ?? current.sessionId,
    wakePrompt: params.fields.wakePrompt ?? current.wakePrompt,
    modelId: params.fields.modelId ?? current.modelId,
    cooldownMinutes: params.fields.cooldownMinutes ?? current.cooldownMinutes,
    enabled: params.fields.enabled ?? current.enabled,
  });

  const scriptChanged = merged.script !== current.script;

  if (merged.name !== current.name) {
    const clash = await prisma.scriptWatcher.findFirst({
      where: { userId, name: merged.name, id: { not: id } },
      select: { id: true },
    });
    if (clash) throw new WatcherInputError(`A watcher named "${merged.name}" already exists.`);
  }

  const grantFields =
    scriptChanged && params.approveScript
      ? await grantedFor(userId, merged.script, merged.sessionId)
      : {};

  const watcher = await prisma.scriptWatcher.update({
    where: { id },
    data: { ...merged, ...grantFields },
  });

  await syncWatcherSchedule(watcher).catch((err) => {
    console.error(`Failed to reschedule watcher ${watcher.id}:`, err);
  });

  return {
    id: watcher.id,
    needsApproval: scriptChanged && !params.approveScript,
  };
}

/** The grant a script earns, from the tool set its owner has right now. */
async function grantedFor(
  userId: string,
  script: string,
  sessionId: string | null,
): Promise<{ scriptHash: string; grantedTools: string[]; grantAll: boolean }> {
  const access = await loadWatcherToolAccess(userId, sessionId ?? PENDING_SCOPE);
  const consent = consentFor({
    script,
    callableNames: access.callableNames,
    toolPolicies: access.toolPolicies,
  });
  return {
    scriptHash: consent.scriptHash,
    grantedTools: consent.grantedTools,
    grantAll: consent.grantAll,
  };
}

/**
 * Approve the watcher's script as it currently stands.
 *
 * This is the user saying "yes, these calls" after a script changed — the same
 * decision the creation dialog carries, applied to an edit.
 */
export async function approveWatcherScript(
  id: string,
  userId: string,
): Promise<{ grantedTools: string[]; grantAll: boolean }> {
  const current = await prisma.scriptWatcher.findFirst({ where: { id, userId } });
  if (!current) throw new WatcherInputError("Watcher not found.");

  const grant = await grantedFor(userId, current.script, current.sessionId);
  await prisma.scriptWatcher.update({ where: { id }, data: grant });

  return { grantedTools: grant.grantedTools, grantAll: grant.grantAll };
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

/**
 * What a script would need consent for, without saving anything.
 *
 * The dialog shows this as the user writes the script, and the tools return it
 * so the model can say what it is about to be allowed to do before it asks for
 * the write to be approved.
 */
export async function previewConsent(params: {
  userId: string;
  script: string;
  sessionId?: string | null;
}): Promise<{
  grantedTools: string[];
  grantAll: boolean;
  /** Which of the granted tools are command-aware and worth calling out. */
  callableCount: number;
}> {
  const access = await loadWatcherToolAccess(
    params.userId,
    params.sessionId ?? `watcher:preview-${params.userId}`,
  );
  const consent = consentFor({
    script: normalizeScript(params.script),
    callableNames: access.callableNames,
    toolPolicies: access.toolPolicies,
  });

  return {
    grantedTools: consent.grantedTools,
    grantAll: consent.grantAll,
    callableCount: access.callableNames.length,
  };
}

/** Whether a stored watcher's script still matches the grant it carries. */
export function needsScriptApproval(watcher: { script: string; scriptHash: string }): boolean {
  return hashScript(watcher.script) !== watcher.scriptHash;
}

/** The shape every reader of a watcher gets — API, tools and UI alike. */
export interface SerializedWatcher {
  id: string;
  name: string;
  description: string | null;
  script: string;
  cronExpression: string;
  enabled: boolean;
  sessionId: string | null;
  sessionTitle: string | null;
  wakePrompt: string;
  modelId: string | null;
  cooldownMinutes: number;
  grantedTools: string[];
  grantAll: boolean;
  needsApproval: boolean;
  tickCount: number;
  fireCount: number;
  lastTickAt: string | null;
  lastFiredAt: string | null;
  lastError: string | null;
  lastValue: string | null;
  createdAt: string;
  updatedAt: string;
}

type WatcherRow = ScriptWatcher & { session?: { title: string } | null };

export function serializeWatcher(watcher: WatcherRow): SerializedWatcher {
  return {
    id: watcher.id,
    name: watcher.name,
    description: watcher.description,
    script: watcher.script,
    cronExpression: watcher.cronExpression,
    enabled: watcher.enabled,
    sessionId: watcher.sessionId,
    sessionTitle: watcher.session?.title ?? null,
    wakePrompt: watcher.wakePrompt,
    modelId: watcher.modelId,
    cooldownMinutes: watcher.cooldownMinutes,
    grantedTools: watcher.grantedTools,
    grantAll: watcher.grantAll,
    needsApproval: needsScriptApproval(watcher),
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
