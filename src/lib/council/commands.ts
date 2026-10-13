/**
 * One-shot commands against the terminal container.
 *
 * Shared by the two identities the council module uses outside a member's own
 * sandbox:
 * - a council's sandbox account, to verify it is what we think it is
 *   (`sandbox.ts`), and
 * - the container's own account, which is root-capable, to reserve and delete a
 *   sandbox account (`accounts.ts`, `sandbox.ts`).
 *
 * Both run one short command and read its result. Polling a long-running command
 * requires the identity that started it, so a command still running when the
 * wait expires reports a null exit code — callers must treat that as "not
 * confirmed", never as success.
 */

import { executeCommand, executeContainerCommand, isConfigured } from "@/lib/terminal/client";

/** How long a command may take before its result is unusable. */
const COMMAND_TIMEOUT_SECONDS = 60;

export interface CouncilCommandResult {
  /** Null when the container never reported one (still running, or dropped). */
  exitCode: number | null;
  output: string;
}

export interface TerminalCommandOptions {
  /** Identity to run as — a sandbox key, or omitted for the container's own. */
  userId?: string;
  sessionId?: string;
  cwd?: string;
  waitSeconds?: number;
}

/**
 * An account name that is safe to interpolate into a command.
 *
 * Open Terminal derives names as `[a-z0-9]+`, optionally behind
 * `OPEN_TERMINAL_USER_PREFIX` — which operators do use, and which may contain
 * `-`, `_` or `.`. The leading character is never a separator (the container
 * refuses what is not `[A-Za-z0-9_]` first), so a name that starts with a digit
 * or a dash is a corrupt value or a bug, never something to run. Everything
 * else here cannot leave a shell word.
 */
const SAFE_ACCOUNT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isSafeAccountName(account: string): boolean {
  return SAFE_ACCOUNT_NAME.test(account);
}

function resultOutputText(output: unknown): string {
  if (!Array.isArray(output)) return "";
  return output
    .map((entry) => {
      if (typeof entry === "string") return entry;
      if (entry && typeof entry === "object") {
        const data = (entry as { data?: unknown }).data;
        if (typeof data === "string") return data;
      }
      // An entry we cannot read is output the caller will never see.
      console.error("Unexpected Open Terminal output entry:", JSON.stringify(entry));
      return "";
    })
    .join("");
}

/** Run one command as the given identity (or the container's own). */
export async function runTerminalCommand(
  command: string,
  options: TerminalCommandOptions = {},
): Promise<CouncilCommandResult> {
  const wait = options.waitSeconds ?? COMMAND_TIMEOUT_SECONDS;

  if (!options.userId) {
    const result = await executeContainerCommand(command, { wait });
    return {
      exitCode: result.status === "done" ? result.exit_code : null,
      output: resultOutputText(result.output),
    };
  }

  const result = await executeCommand(command, {
    userId: options.userId,
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    ...(options.cwd ? { cwd: options.cwd } : {}),
    wait,
  });
  return {
    exitCode: result.status === "done" ? result.exit_code : null,
    output: resultOutputText(result.output),
  };
}

/** Run one command as the container's own (root-capable) account. */
export function runContainerCommand(
  command: string,
  waitSeconds?: number,
): Promise<CouncilCommandResult> {
  return runTerminalCommand(command, waitSeconds ? { waitSeconds } : {});
}

/**
 * Whether the container already has this account.
 *
 * `getent` exits 0 for a known name and 2 for an unknown one, and any account
 * may read it. A council's key is only accepted when this says the account is
 * free, so a hash collision can never put a council inside a workspace that
 * already exists.
 */
export async function containerAccountExists(account: string): Promise<boolean> {
  if (!isConfigured()) return false;
  if (!isSafeAccountName(account)) {
    throw new Error(`Refusing to look up an unsafe account name: ${account}`);
  }
  const { exitCode } = await runContainerCommand(`getent passwd ${account} >/dev/null 2>&1`);
  return exitCode === 0;
}
