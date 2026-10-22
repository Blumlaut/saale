/**
 * The one handle a caller passes when it wants a workspace.
 *
 * An identity is a directory in the workspaces volume, a container name, a
 * mount subpath and an audit label. It is a string because every one of those
 * uses a string; the service derives all four from it, so a caller cannot pass
 * a path.
 */

/** `user-<id>` or `council-<sandboxKey>`: no separators, no dots, no `..`. */
const IDENTITY_PATTERN = /^(user|council)-[A-Za-z0-9_-]{1,64}$/;

/** Raised for a string that is not an identity. */
export class InvalidSandboxIdentityError extends Error {
  constructor(raw: unknown) {
    super(`Not a sandbox identity: ${String(raw)}`);
    this.name = "InvalidSandboxIdentityError";
  }
}

/** Whether `raw` names a workspace. */
export function isSandboxIdentity(raw: unknown): raw is string {
  return typeof raw === "string" && IDENTITY_PATTERN.test(raw);
}

/** `raw` as an identity, or a throw. The service's gate on `X-Identity`. */
export function parseIdentity(raw: unknown): string {
  if (!isSandboxIdentity(raw)) throw new InvalidSandboxIdentityError(raw);
  return raw;
}

/** A Saale user's own workspace. */
export function userIdentity(userId: string): string {
  return parseIdentity(`user-${userId}`);
}

/** A council's shared workspace, named by its stored `sandboxKey`. */
export function councilIdentity(sandboxKey: string): string {
  return parseIdentity(`council-${sandboxKey}`);
}
