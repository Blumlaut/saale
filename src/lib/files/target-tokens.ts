/**
 * The target tokens, apart from the modules that resolve them.
 *
 * A client picks the token it sends without learning how one is opened, and
 * importing them from `targets.ts` would drag its database and SSH code into
 * the browser bundle.
 */

/** The token for a user's own workspace. */
export const USER_FILE_TARGET = "user";

/** The prefix of a token for one of the user's machines. */
export const MACHINE_FILE_TARGET_PREFIX = "machine:";

/** The token that names one machine's files. */
export function machineFileTarget(machineId: string): string {
  return `${MACHINE_FILE_TARGET_PREFIX}${machineId}`;
}

/** A token a client sent, resolved to what it names. */
export type ParsedFileTarget = { kind: "workspace" } | { kind: "machine"; machineId: string };

/**
 * Read a target token.
 *
 * Empty and missing mean the user's own workspace, which is what a browser with
 * no connection sends. Anything this module does not name is refused here,
 * before a provider is built for it.
 */
export function parseFileTargetToken(raw: string | null | undefined): ParsedFileTarget | null {
  if (!raw || raw === USER_FILE_TARGET) return { kind: "workspace" };
  if (!raw.startsWith(MACHINE_FILE_TARGET_PREFIX)) return null;

  const machineId = raw.slice(MACHINE_FILE_TARGET_PREFIX.length);
  return machineId ? { kind: "machine", machineId } : null;
}
