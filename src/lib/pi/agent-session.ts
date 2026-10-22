import {
  createAgentSession,
  type CreateAgentSessionOptions,
  type CreateAgentSessionResult,
} from "@earendil-works/pi-coding-agent";
import { userWorkspacePath } from "@/lib/sandbox/workspace";
import { createSessionSettings } from "./settings";

/**
 * Working directory an agent session runs in: the user's workspace.
 *
 * Pi resolves every relative tool path against the *session* cwd (`ctx.cwd`),
 * which takes precedence over the cwd passed to `createReadTool` /
 * `createWriteTool`. Those paths are handed to the sandbox, so the session cwd
 * must be one the workspace has. the same string the container sees.
 */
export function resolveAgentCwd(userId: string): string {
  return userWorkspacePath(userId);
}

/**
 * Create a Pi agent session for a Saale user.
 *
 * Every session goes through here so the two things a caller must not get
 * wrong are applied centrally:
 * - the working directory is the user's workspace (see `resolveAgentCwd`);
 * - settings are the in-memory Saale defaults, never the host's `~/.pi` config
 *   (see `createSessionSettings`).
 *
 * `cwd` and `settingsManager` are deliberately not accepted from callers: a
 * session that sets its own cwd would reintroduce the host-path leak this
 * wrapper exists to prevent, and a caller-set settings manager would let the
 * host's Pi configuration shape a tenant's session.
 */
export async function createSaaleAgentSession(
  userId: string,
  options: Omit<CreateAgentSessionOptions, "cwd" | "settingsManager">,
): Promise<CreateAgentSessionResult> {
  return createAgentSession({
    ...options,
    cwd: resolveAgentCwd(userId),
    settingsManager: createSessionSettings(),
  });
}
