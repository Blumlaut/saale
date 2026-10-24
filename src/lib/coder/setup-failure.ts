/**
 * The record of a setup script that failed in a new checkout.
 *
 * A failing script does not block the chat. the checkout exists, so the agent
 * starts anyway. That leaves the failure silent: no reply ever says the install
 * broke, and the agent works in a tree with no dependencies. This record is what
 * the chat's sidebar reads to say so, and it is kept out of the session row
 * because the next successful build clears it.
 *
 * Redis, like the provisioning record: the failure belongs to a build, is
 * written by the run that did it, and a stale one must not outlive the project's
 * own fix forever.
 */

import { getRedis } from "@/lib/redis";

/** What a failed setup script says about itself. */
export interface SetupFailure {
  /** Exit status of the script, null when it never got to run. */
  exitCode: number | null;
  /** The tail of what it printed, which is where the error is. */
  output: string;
  /** ISO time of the failure, so the panel can date it. */
  failedAt: string;
}

const SETUP_FAILURE_PREFIX = "coder:setup-failure:";

/**
 * Long enough that a user who comes back the next day still sees why their
 * worktree is half-built, short enough that a repo nobody fixed forgets.
 */
const SETUP_FAILURE_TTL_SECONDS = 30 * 24 * 60 * 60;

const key = (sessionId: string) => `${SETUP_FAILURE_PREFIX}${sessionId}`;

/**
 * A stored record, or null for anything that is not one.
 *
 * Written by one version and read by another, so a record with a field missing
 * or of the wrong type is no record: the sidebar has to be able to trust what it
 * shows. An empty output is allowed. a script can fail without printing.
 */
export function parseSetupFailure(raw: string | null): SetupFailure | null {
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error("Ignoring an unreadable setup failure record:", err);
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const { exitCode, output, failedAt } = parsed as {
    exitCode?: unknown;
    output?: unknown;
    failedAt?: unknown;
  };
  if (typeof exitCode !== "number" && exitCode !== null) return null;
  if (typeof output !== "string") return null;
  if (typeof failedAt !== "string" || Number.isNaN(Date.parse(failedAt))) return null;

  return { exitCode, output, failedAt };
}

/** Keep what a failed setup script said, so the chat can show it later. */
export async function recordSetupFailure(
  sessionId: string,
  failure: { exitCode: number | null; output: string },
): Promise<void> {
  try {
    const record: SetupFailure = {
      exitCode: failure.exitCode,
      output: failure.output,
      failedAt: new Date().toISOString(),
    };
    await getRedis().set(key(sessionId), JSON.stringify(record), "EX", SETUP_FAILURE_TTL_SECONDS);
  } catch (err) {
    // The record is a courtesy: a chat that cannot say its install broke still
    // works, so this never fails the run that made the checkout.
    console.error(`Failed to record the setup failure for ${sessionId}:`, err);
  }
}

/** The setup failure this chat's workspace has, or null when it has none. */
export async function getSetupFailure(sessionId: string): Promise<SetupFailure | null> {
  try {
    return parseSetupFailure(await getRedis().get(key(sessionId)));
  } catch (err) {
    console.error(`Failed to read the setup failure for ${sessionId}:`, err);
    return null;
  }
}

/** Drop the record once a build runs the setup script successfully. */
export async function clearSetupFailure(sessionId: string): Promise<void> {
  try {
    await getRedis().del(key(sessionId));
  } catch (err) {
    console.error(`Failed to clear the setup failure for ${sessionId}:`, err);
  }
}
