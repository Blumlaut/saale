/**
 * The one handle a caller passes when it wants a workspace.
 *
 * An identity is a directory in the workspaces volume, a container name, a
 * mount subpath and an audit label. It is a string because every one of those
 * uses a string; the service derives all four from it, so a caller cannot pass
 * a path.
 */

import { createHash } from "node:crypto";

/** `user-<key>` or `council-<sandboxKey>`: no separators, no dots, no `..`. */
const IDENTITY_PATTERN = /^(user|council)-[A-Za-z0-9_-]{1,64}$/;

/**
 * Hex characters in a user's workspace key.
 *
 * Twelve is 48 bits: wide enough that two users of one instance do not land in
 * one directory (a few thousand of them are about 1e-7 apart), short enough
 * that the paths an agent reads and types stay short. The user id is 30+
 * characters, and every file path under a workspace repeats the directory name.
 */
export const USER_WORKSPACE_KEY_LENGTH = 12;

/**
 * Namespace for that hash. Domain separation keeps a user's key out of the
 * space of every other hash in the app (councils' `sandboxKey`, preview slugs),
 * so no two things can be derived to the same string from the same input.
 */
const USER_WORKSPACE_KEY_NAMESPACE = "saale-user-workspace:v1";

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

/**
 * The key that names a user's workspace directory.
 *
 * Derived rather than stored: the id is the one thing every caller already has,
 * and a directory name is needed in places that cannot wait for a query. It is
 * a hash so the key stays short and says nothing about the account behind it.
 */
export function deriveUserWorkspaceKey(userId: string): string {
  if (typeof userId !== "string" || userId.length === 0) {
    throw new InvalidSandboxIdentityError(userId);
  }
  return createHash("sha256")
    .update(`${USER_WORKSPACE_KEY_NAMESPACE}:${userId}`)
    .digest("hex")
    .slice(0, USER_WORKSPACE_KEY_LENGTH);
}

/** A Saale user's own workspace: `user-<key>`, never the id itself. */
export function userIdentity(userId: string): string {
  return parseIdentity(`user-${deriveUserWorkspaceKey(userId)}`);
}

/** A council's shared workspace, named by its stored `sandboxKey`. */
export function councilIdentity(sandboxKey: string): string {
  return parseIdentity(`council-${sandboxKey}`);
}
