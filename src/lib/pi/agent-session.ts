import {
  createAgentSession,
  type CreateAgentSessionOptions,
  type CreateAgentSessionResult,
} from "@earendil-works/pi-coding-agent";
import { getTerminalHomeDir, isConfigured as isTerminalConfigured } from "@/lib/terminal/client";
import { createSessionSettings } from "./settings";

/**
 * Working directory an agent session runs in.
 *
 * Pi resolves every relative tool path against the *session* cwd (`ctx.cwd`),
 * which takes precedence over the cwd passed to `createReadTool` /
 * `createWriteTool`. With the terminal backend those resolved paths are
 * executed inside Open Terminal, so the session cwd must be a path that exists
 * there — the user's home. The JSONL transcript directory lives on this app's
 * uploads volume, which Open Terminal cannot see: using it as the session cwd
 * made `write`/`edit` create `/app/uploads/...` inside the container, where the
 * unprivileged session user has no write access.
 */
export function resolveAgentCwd(userId: string, fallback: string): string {
  return isTerminalConfigured() ? getTerminalHomeDir(userId) : fallback;
}

/**
 * Create a Pi agent session for a Saale user.
 *
 * Every session goes through here so the two things a caller must not get
 * wrong are applied centrally:
 * - the working directory is the user's Open Terminal home when the terminal
 *   is configured (see `resolveAgentCwd`);
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
  const fallback = options.sessionManager?.getCwd() ?? process.cwd();
  return createAgentSession({
    ...options,
    cwd: resolveAgentCwd(userId, fallback),
    settingsManager: createSessionSettings(),
  });
}
