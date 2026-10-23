import {
  createAgentSession,
  type CreateAgentSessionOptions,
  type CreateAgentSessionResult,
} from "@earendil-works/pi-coding-agent";
import { requireWithinRoot } from "@/lib/files/paths";
import { userWorkspacePath } from "@/lib/sandbox/workspace";
import { createSessionSettings } from "./settings";

/**
 * Working directory an agent session runs in: the user's workspace, or a
 * workspace-relative directory inside it.
 *
 * Pi resolves every relative tool path against the *session* cwd (`ctx.cwd`),
 * which takes precedence over the cwd passed to `createReadTool` /
 * `createWriteTool`. Those paths are handed to the sandbox, so the session cwd
 * must be one the workspace has. the same string the container sees.
 *
 * `workspaceRelative` is what a coder chat passes for its worktree. It is
 * resolved against the root and refused when it leaves it, so a caller can
 * name a directory but never an app path.
 */
export function resolveAgentCwd(userId: string, workspaceRelative?: string): string {
  const root = userWorkspacePath(userId);
  return workspaceRelative ? requireWithinRoot(root, workspaceRelative) : root;
}

/** Options for {@link createSaaleAgentSession}, minus the two it owns. */
export type SaaleAgentSessionOptions = Omit<
  CreateAgentSessionOptions,
  "cwd" | "settingsManager"
> & {
  /** Workspace-relative directory to run in. the workspace root when omitted. */
  workspaceCwd?: string | undefined;
};

/**
 * Create a Pi agent session for a Saale user.
 *
 * Every session goes through here so the two things a caller must not get
 * wrong are applied centrally:
 * - the working directory is the user's workspace, or a directory inside it
 *   (see `resolveAgentCwd`);
 * - settings are the in-memory Saale defaults, never the host's `~/.pi` config
 *   (see `createSessionSettings`).
 *
 * `cwd` and `settingsManager` are deliberately not accepted from callers: a
 * session that sets its own cwd would reintroduce the host-path leak this
 * wrapper exists to prevent, and a caller-set settings manager would let the
 * host's Pi configuration shape a tenant's session. A caller with something
 * more specific than the workspace root names it as `workspaceCwd`.
 */
export async function createSaaleAgentSession(
  userId: string,
  options: SaaleAgentSessionOptions,
): Promise<CreateAgentSessionResult> {
  const { workspaceCwd, ...rest } = options;
  return createAgentSession({
    ...rest,
    cwd: resolveAgentCwd(userId, workspaceCwd),
    settingsManager: createSessionSettings(),
  });
}
