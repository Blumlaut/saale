/**
 * What a chat is doing while its workspace is built.
 *
 * The first message of a coder chat makes the worktree, writes the project's
 * env files, then runs its setup script. the install that can take minutes.
 * During all of it the agent has produced nothing, so without this record the
 * chat looks stuck: the composer spins and no reply ever starts.
 *
 * Redis, not a column: this describes work in flight, it is written by the run
 * that does the work, and a record left behind by a crash has to expire on its
 * own instead of outliving the run on a chat row.
 */

import { getRedis } from "@/lib/redis";
import { SETUP_TIMEOUT_SECONDS } from "./project-config";

/** One stage of building a chat's workspace. */
export type ProvisioningStep = "worktree" | "setup";

export interface ProvisioningState {
  step: ProvisioningStep;
  /** ISO start of the current step, so the client can show how long it ran. */
  startedAt: string;
}

const PROVISIONING_PREFIX = "coder:provisioning:";

/**
 * Comfortably longer than a setup script is allowed to run, so the record of a
 * live setup never expires under it, while a crashed one still clears itself.
 */
const PROVISIONING_TTL_SECONDS = SETUP_TIMEOUT_SECONDS * 2;

const STEPS: readonly ProvisioningStep[] = ["worktree", "setup"];

const key = (sessionId: string) => `${PROVISIONING_PREFIX}${sessionId}`;

function isStep(value: unknown): value is ProvisioningStep {
  return STEPS.includes(value as ProvisioningStep);
}

/**
 * A stored record, or null for anything that is not one.
 *
 * A record written by an older version can have a step this one does not know;
 * the callers show a hint, so they must not be handed a step they cannot name.
 */
export function parseProvisioning(raw: string | null): ProvisioningState | null {
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error("Ignoring an unreadable provisioning record:", err);
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const { step, startedAt } = parsed as { step?: unknown; startedAt?: unknown };
  if (!isStep(step)) return null;
  if (typeof startedAt !== "string" || Number.isNaN(Date.parse(startedAt))) return null;

  return { step, startedAt };
}

/** Record that this chat is now at `step`. */
export async function setProvisioningStep(
  sessionId: string,
  step: ProvisioningStep,
): Promise<void> {
  try {
    const state: ProvisioningState = { step, startedAt: new Date().toISOString() };
    await getRedis().set(key(sessionId), JSON.stringify(state), "EX", PROVISIONING_TTL_SECONDS);
  } catch (err) {
    // The hint is a courtesy. a chat that cannot say what it is doing still
    // gets its workspace, so this never fails the run.
    console.error(`Failed to record the provisioning step for ${sessionId}:`, err);
  }
}

/** What this chat is building right now, or null when it is not building any. */
export async function getProvisioning(sessionId: string): Promise<ProvisioningState | null> {
  try {
    return parseProvisioning(await getRedis().get(key(sessionId)));
  } catch (err) {
    console.error(`Failed to read the provisioning step for ${sessionId}:`, err);
    return null;
  }
}

/** Drop the record once the workspace is ready (or the build gave up). */
export async function clearProvisioning(sessionId: string): Promise<void> {
  try {
    await getRedis().del(key(sessionId));
  } catch (err) {
    console.error(`Failed to clear the provisioning step for ${sessionId}:`, err);
  }
}
